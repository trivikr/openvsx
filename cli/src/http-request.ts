/******************************************************************************
 * Copyright (c) 2026 Contributors to the Eclipse Foundation.
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License 2.0 which is available at
 * https://www.eclipse.org/legal/epl-2.0.
 *
 * SPDX-License-Identifier: EPL-2.0
 *****************************************************************************/

import * as http from 'http';
import * as https from 'https';
import { Writable } from 'stream';

// Same hop limit follow-redirects used.
const MAX_REDIRECTS = 21;

// Credentials that must not reach another host. X-OpenVSX-Token carries the PAT when
// Authorization is claimed by Basic auth to a fronting proxy.
const SENSITIVE_HEADERS = /^(?:authorization|cookie|proxy-authorization|x-openvsx-token)$/i;

export interface HttpRequestOptions extends http.RequestOptions {
    /** Largest request body accepted, in bytes; a larger one fails the request before it is sent. */
    maxBodyLength?: number;
}

/**
 * `http.request`/`https.request` that follows redirects. The request body is kept so a 307/308 can
 * replay it, and a timeout raises 'timeout' on the returned stream, as on a `ClientRequest`.
 */
export function httpRequest(url: URL, options: HttpRequestOptions, callback: (response: http.IncomingMessage) => void): Writable {
    return new RedirectableRequest(url, options, callback);
}

class RedirectableRequest extends Writable {

    private url: URL;
    private method: string;
    private readonly headers: http.OutgoingHttpHeaders;
    private readonly options: http.RequestOptions;
    private readonly maxBodyLength: number;
    private readonly body: Buffer[] = [];
    private bodyLength = 0;
    private bodyDropped = false;
    private ended = false;
    private redirects = 0;
    private current?: http.ClientRequest;

    constructor(url: URL, options: HttpRequestOptions, private readonly callback: (response: http.IncomingMessage) => void) {
        super();
        const { maxBodyLength, method, headers, ...rest } = options;
        this.url = url;
        this.method = method ?? 'GET';
        this.headers = { ...headers as http.OutgoingHttpHeaders };
        this.options = rest;
        this.maxBodyLength = maxBodyLength ?? Infinity;
        this.send();
    }

    override _write(chunk: Buffer, _encoding: BufferEncoding, done: (err?: Error | null) => void): void {
        if (this.bodyLength + chunk.length > this.maxBodyLength) {
            done(new Error('Request body larger than maxBodyLength limit'));
            return;
        }
        this.bodyLength += chunk.length;
        if (this.bodyDropped || !this.current) {
            done();
            return;
        }
        this.body.push(chunk);
        // A request torn down by a redirect fails its pending writes; the stream carries on regardless.
        this.current.write(chunk, () => done());
    }

    override _final(done: (err?: Error | null) => void): void {
        this.ended = true;
        this.current?.end();
        done();
    }

    override _destroy(err: Error | null, done: (err?: Error | null) => void): void {
        this.current?.destroy();
        done(err);
    }

    private send(): void {
        const protocol = this.url.protocol === 'https:' ? https : this.url.protocol === 'http:' ? http : undefined;
        if (!protocol) {
            this.current = undefined;
            this.destroy(new Error(`Unsupported protocol ${this.url.protocol}`));
            return;
        }
        const request = protocol.request(this.url, { ...this.options, method: this.method, headers: this.headers },
            response => this.onResponse(request, response));
        this.current = request;
        request.on('error', err => {
            if (this.current === request) {
                this.destroy(err);
            }
        });
        request.on('timeout', () => {
            if (this.current === request) {
                this.emit('timeout');
            }
        });
        for (const chunk of this.body) {
            request.write(chunk);
        }
        if (this.ended) {
            request.end();
        }
    }

    private onResponse(request: http.ClientRequest, response: http.IncomingMessage): void {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (!location || status < 300 || status >= 400) {
            this.body.length = 0;
            this.callback(response);
            return;
        }

        response.destroy();
        request.destroy();
        if (++this.redirects > MAX_REDIRECTS) {
            this.destroy(new Error('Maximum number of redirects exceeded'));
            return;
        }
        let next: URL;
        try {
            next = new URL(location, this.url);
        } catch (err) {
            this.destroy(err as Error);
            return;
        }
        // 301/302 after a POST and 303 after anything but GET/HEAD continue as a GET without the body.
        if ((status === 301 || status === 302) && this.method === 'POST'
            || status === 303 && !/^(?:GET|HEAD)$/.test(this.method)) {
            this.method = 'GET';
            this.body.length = 0;
            this.bodyDropped = true;
            removeHeaders(this.headers, /^content-/i);
        }
        if (next.protocol !== this.url.protocol && next.protocol !== 'https:'
            || next.host !== this.url.host && !isSubdomain(next.host, this.url.host)) {
            removeHeaders(this.headers, SENSITIVE_HEADERS);
        }
        this.url = next;
        this.send();
    }
}

function removeHeaders(headers: http.OutgoingHttpHeaders, pattern: RegExp): void {
    for (const name of Object.keys(headers)) {
        if (pattern.test(name)) {
            delete headers[name];
        }
    }
}

function isSubdomain(subdomain: string, domain: string): boolean {
    const dot = subdomain.length - domain.length - 1;
    return dot > 0 && subdomain[dot] === '.' && subdomain.endsWith(domain);
}
