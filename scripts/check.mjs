import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import process from 'node:process';

const root = new URL('../', import.meta.url);
const sourceRoots = ['src', 'test', 'scripts', 'demo'];
const files = [];

async function collect(directory) {
	let entries;
	try {
		entries = await readdir(new URL(`${directory}/`, root), { withFileTypes: true });
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}

	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			await collect(path);
		} else if (['.js', '.mjs'].includes(extname(entry.name))) {
			files.push(path);
		}
	}
}

for (const directory of sourceRoots) {
	await collect(directory);
}

let failed = false;
for (const file of files.sort()) {
	const absolute = new URL(file, root);
	const source = await readFile(absolute, 'utf8');
	for (const [index, line] of source.split('\n').entries()) {
		if (/[ \t]+$/.test(line)) {
			console.error(`${file}:${index + 1}: trailing whitespace`);
			failed = true;
		}
	}

	const result = spawnSync(process.execPath, ['--check', absolute.pathname], {
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		console.error(result.stderr.trim());
		failed = true;
	}
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
if (Object.keys(packageJson.dependencies ?? {}).length !== 0) {
	console.error('Runtime dependencies are not allowed.');
	failed = true;
}

if (failed) {
	process.exitCode = 1;
} else {
	console.log(`Checked ${files.length} JavaScript files; no runtime dependencies.`);
}
