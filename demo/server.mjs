import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const demoRoot = resolve(root, 'demo');
const sourceRoot = resolve(root, 'src');
const host = process.env.HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.PORT ?? '4173', 10);
const mimeTypes = new Map([
	['.css', 'text/css; charset=utf-8'],
	['.html', 'text/html; charset=utf-8'],
	['.js', 'text/javascript; charset=utf-8'],
	['.json', 'application/json; charset=utf-8'],
	['.md', 'text/markdown; charset=utf-8'],
	['.mjs', 'text/javascript; charset=utf-8'],
]);

function send(response, statusCode, body, headers = {}) {
	response.writeHead(statusCode, {
		'Content-Type': 'text/plain; charset=utf-8',
		...headers,
	});
	response.end(body);
}

export function resolvePublicFile(pathname) {
	if (pathname === '/README.md') {
		return resolve(root, 'README.md');
	}

	const publicRoots = [
		['/demo/', demoRoot],
		['/src/', sourceRoot],
	];
	for (const [prefix, publicRoot] of publicRoots) {
		if (!pathname.startsWith(prefix)) {
			continue;
		}
		const relativePath = pathname.slice(prefix.length);
		if (!relativePath || relativePath.split('/').some((part) => part.startsWith('.'))) {
			return null;
		}
		const file = resolve(publicRoot, relativePath);
		return file.startsWith(`${publicRoot}${sep}`) ? file : null;
	}
	return null;
}

export function createDemoServer() {
	return createServer(async (request, response) => {
		if (!['GET', 'HEAD'].includes(request.method)) {
			send(response, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
			return;
		}

		let pathname;
		try {
			pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
		} catch {
			send(response, 400, 'Bad request');
			return;
		}

		if (pathname === '/') {
			response.writeHead(302, { Location: '/demo/' });
			response.end();
			return;
		}
		if (pathname === '/demo') {
			response.writeHead(301, { Location: '/demo/' });
			response.end();
			return;
		}
		if (pathname === '/demo/') {
			pathname = '/demo/index.html';
		}

		const file = resolvePublicFile(pathname);
		if (!file) {
			send(response, 404, 'Not found');
			return;
		}

		try {
			const details = await stat(file);
			if (!details.isFile()) {
				throw new Error('Not a file');
			}
			response.writeHead(200, {
				'Cache-Control': 'no-store',
				'Content-Length': details.size,
				'Content-Security-Policy': "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'",
				'Content-Type': mimeTypes.get(extname(file)) ?? 'application/octet-stream',
				'Permissions-Policy': 'camera=(self), microphone=()',
				'X-Content-Type-Options': 'nosniff',
			});
			if (request.method === 'HEAD') {
				response.end();
			} else {
				createReadStream(file).pipe(response);
			}
		} catch {
			send(response, 404, 'Not found');
		}
	});
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const server = createDemoServer();
	server.listen(port, host, () => {
		console.log(`resilient-webcam demo: http://${host}:${port}/demo/`);
	});
}
