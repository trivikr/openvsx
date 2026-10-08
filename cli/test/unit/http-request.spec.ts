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
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';
import { httpRequest } from '../../src/http-request';
import { Registry } from '../../src/registry';

interface Received {
    method?: string;
    url?: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

describe('httpRequest', () => {
    const servers: http.Server[] = [];
    const files: string[] = [];

    afterEach(async () => {
        for (const file of files.splice(0)) {
            fs.rmSync(file, { force: true });
        }
        for (const server of servers.splice(0)) {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });

    /** Serves `handler`, recording every request it receives with its body. */
    async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
        const received: Received[] = [];
        const server = http.createServer((req, res) => {
            let body = '';
            req.setEncoding('utf-8');
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                received.push({ method: req.method, url: req.url, headers: req.headers, body });
                handler(req, res);
            });
        });
        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received };
    }

    function redirectTo(status: number, location: string) {
        return (_: http.IncomingMessage, res: http.ServerResponse) => {
            res.writeHead(status, { Location: location });
            res.end();
        };
    }

    function ok(_: http.IncomingMessage, res: http.ServerResponse) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
    }

    function send(url: string, options: Parameters<typeof httpRequest>[1], body?: string): Promise<http.IncomingMessage> {
        return new Promise((resolve, reject) => {
            const request = httpRequest(new URL(url), options, response => {
                response.resume();
                response.on('end', () => resolve(response));
            });
            request.on('error', reject);
            request.end(body);
        });
    }

    it('follows a redirect for a GET', async () => {
        const target = await serve(ok);
        const origin = await serve(redirectTo(302, `${target.url}/file`));
        const response = await send(`${origin.url}/start`, { method: 'GET' });
        expect(response.statusCode).toBe(200);
        expect(target.received.map(r => r.url)).toEqual(['/file']);
    });

    it('replays the request body on a 307', async () => {
        let first = true;
        const server = await serve((req, res) => {
            if (first) {
                first = false;
                redirectTo(307, '/second')(req, res);
            } else {
                ok(req, res);
            }
        });
        await send(`${server.url}/first`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'payload');
        expect(server.received.map(r => [r.method, r.url, r.body])).toEqual([
            ['POST', '/first', 'payload'],
            ['POST', '/second', 'payload']
        ]);
    });

    it('turns a POST into a GET without the body on a 302', async () => {
        const target = await serve(ok);
        const origin = await serve(redirectTo(302, `${target.url}/next`));
        await send(origin.url, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }, 'payload');
        expect(target.received).toHaveLength(1);
        expect(target.received[0].method).toBe('GET');
        expect(target.received[0].body).toBe('');
        expect(target.received[0].headers['content-type']).toBeUndefined();
    });

    it('keeps credentials on a redirect to the same host', async () => {
        let first = true;
        const server = await serve((req, res) => {
            if (first) {
                first = false;
                redirectTo(302, '/second')(req, res);
            } else {
                ok(req, res);
            }
        });
        await send(server.url, { method: 'GET', headers: { Authorization: 'Basic abc', 'X-OpenVSX-Token': 'the.pat' } });
        expect(server.received[1].headers.authorization).toBe('Basic abc');
        expect(server.received[1].headers['x-openvsx-token']).toBe('the.pat');
    });

    it('drops Authorization and X-OpenVSX-Token on a redirect to another host', async () => {
        const target = await serve(ok);
        const origin = await serve(redirectTo(302, `${target.url}/file`));
        await send(origin.url, {
            method: 'GET',
            headers: { Authorization: 'Basic abc', 'x-openvsx-token': 'the.pat', Cookie: 'a=b', Accept: 'application/json' }
        });
        const { headers } = target.received[0];
        expect(headers.authorization).toBeUndefined();
        expect(headers['x-openvsx-token']).toBeUndefined();
        expect(headers.cookie).toBeUndefined();
        expect(headers.accept).toBe('application/json');
    });

    it('fails after too many redirects', async () => {
        const server = await serve(redirectTo(302, '/again'));
        await expect(send(server.url, { method: 'GET' })).rejects.toThrow('Maximum number of redirects exceeded');
        expect(server.received).toHaveLength(22);
    });

    it('fails on a redirect to an unsupported protocol', async () => {
        const server = await serve(redirectTo(302, 'ftp://127.0.0.1/file'));
        await expect(send(server.url, { method: 'GET' })).rejects.toThrow('Unsupported protocol ftp:');
    });

    it('refuses a body larger than maxBodyLength before sending it', async () => {
        const server = await serve(ok);
        await expect(send(server.url, { method: 'POST', maxBodyLength: 4 }, 'too long'))
            .rejects.toThrow('Request body larger than maxBodyLength limit');
    });

    it('raises timeout on a silent server after a redirect', async () => {
        const silent = await serve(() => { /* never responds */ });
        const origin = await serve(redirectTo(302, silent.url));
        const timedOut = await new Promise<boolean>(resolve => {
            const request = httpRequest(new URL(origin.url), { method: 'GET', timeout: 100 }, () => resolve(false));
            request.on('timeout', () => {
                request.destroy();
                resolve(true);
            });
            request.on('error', () => { /* raised by destroy */ });
            request.end();
        });
        expect(timedOut).toBe(true);
    });

    it('lets Registry.download follow the registry redirect to storage', async () => {
        const storage = await serve((_, res) => {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end('vsix bytes');
        });
        const registry = await serve(redirectTo(302, `${storage.url}/ns/ext/1.0.0/file.vsix`));
        const file = path.join(os.tmpdir(), `ovsx-http-request-test-${process.pid}-${Date.now()}.vsix`);
        files.push(file);
        await new Registry({ registryUrl: registry.url, username: 'user', password: 'secret' })
            .download(file, new URL(`${registry.url}/api/ns/ext/1.0.0/file/file.vsix`));
        expect(fs.readFileSync(file, 'utf-8')).toBe('vsix bytes');
        expect(registry.received[0].headers.authorization).toMatch(/^Basic /);
        expect(storage.received[0].headers.authorization).toBeUndefined();
    });

    it('replays a published file on a 307 and drops the PAT on the way to another host', async () => {
        const target = await serve(ok);
        const origin = await serve((req, res) => {
            if (req.url?.startsWith('/api/version')) {
                ok(req, res);
            } else {
                redirectTo(307, `${target.url}/api/-/publish`)(req, res);
            }
        });
        const file = path.join(os.tmpdir(), `ovsx-http-request-test-${process.pid}-${Date.now()}.vsix`);
        files.push(file);
        fs.writeFileSync(file, 'package');
        await new Registry({ registryUrl: origin.url, username: 'user', password: 'secret' }).publish(file, 'the.pat');
        const publish = origin.received.find(r => r.url?.startsWith('/api/-/publish'));
        expect(publish?.headers['x-openvsx-token']).toBe('the.pat');
        expect(target.received[0].body).toBe('package');
        expect(target.received[0].headers['x-openvsx-token']).toBeUndefined();
        expect(target.received[0].headers.authorization).toBeUndefined();
    });
});
