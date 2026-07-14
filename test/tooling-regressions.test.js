import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolvePublicFile } from '../demo/server.mjs';

test('the demo server resolves only its explicit public files', () => {
	assert.match(resolvePublicFile('/demo/index.html'), /demo[/\\]index\.html$/);
	assert.match(resolvePublicFile('/src/index.js'), /src[/\\]index\.js$/);
	assert.match(resolvePublicFile('/README.md'), /README\.md$/);
	for (const pathname of [
		'/.git/config',
		'/.env',
		'/package.json',
		'/index.d.ts',
		'/demo/.secret',
		'/demo/../package.json',
	]) {
		assert.equal(resolvePublicFile(pathname), null, pathname);
	}
});

test('syntax checking works from a checkout path with spaces and non-ASCII text', async (context) => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), 'resilient webcam ł '));
	context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
	await mkdir(join(temporaryRoot, 'scripts'));
	await mkdir(join(temporaryRoot, 'src'));
	await copyFile(
		fileURLToPath(new URL('../scripts/check.mjs', import.meta.url)),
		join(temporaryRoot, 'scripts', 'check.mjs'),
	);
	await writeFile(
		join(temporaryRoot, 'package.json'),
		JSON.stringify({ type: 'module', dependencies: {} }),
		'utf8',
	);
	await writeFile(join(temporaryRoot, 'src', 'index.js'), 'export const ok = true;\n', 'utf8');

	const result = spawnSync(process.execPath, [join(temporaryRoot, 'scripts', 'check.mjs')], {
		encoding: 'utf8',
	});
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('ErrorCodes declarations retain each runtime literal type', async () => {
	const declaration = await readFile(new URL('../index.d.ts', import.meta.url), 'utf8');
	assert.match(declaration, /PERMISSION_DENIED: 'PERMISSION_DENIED';/);
	assert.doesNotMatch(declaration, /ErrorCodes: Readonly<Record</);
});
