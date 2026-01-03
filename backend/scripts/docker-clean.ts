import { spawnSync } from 'node:child_process';
import path from 'node:path';

// IS ERRNO EXCEPTION ---
// Steps: detect Node-ish spawn errors by presence of `.code`, so callers can branch on ENOENT safely.
function isErrnoException(error) {
	return Boolean(error) && typeof error === 'object' && 'code' in error;
}

// ARGUMENT PARSING -------------------------------------------------------------
const args = process.argv.slice(2);
let composeFileArg;
let pruneVolumes = false;
const projects = new Set();

// POSITIONAL COLLECTION --------------------------------------------------------
// Steps: collect all non-flag tokens first so we can interpret “compose file then projects” deterministically.
const positional = [];
for (const arg of args) {
	if (arg === '--prune-volumes') {
		pruneVolumes = true;
		continue;
	}
	if (arg.startsWith('--project=')) {
		addProjects(arg.substring('--project='.length));
		continue;
	}
	if (arg.startsWith('--add-project=')) {
		addProjects(arg.substring('--add-project='.length));
		continue;
	}
	positional.push(arg);
}

if (positional.length) {
	// POSITIONAL SHAPE ---
	// Steps: first positional is compose file path, remainder are extra projects to include.
	composeFileArg = positional.shift();
	positional.forEach(addProjects);
}

// DEFAULTS + DERIVED PROJECTS ---
// Steps: always include canonical `ministerra`, plus the compose file folder name, so both common naming schemes get cleaned.
const composeFile = path.resolve(composeFileArg || 'backend/docker-compose.yml');
addProjects('ministerra');
addProjects(path.basename(path.dirname(composeFile)));

const removedIds = new Set<string>();
const projectList = Array.from(projects).filter(value => Boolean(value));

for (const project of projectList) {
	// COMPOSE DOWN FIRST ---
	// Steps: prefer plugin (`docker compose`), fall back to legacy binary, then continue regardless of exit code.
	const composeArgs = ['-p', project, '-f', composeFile, 'down', '--remove-orphans'];
	const composeRan = runComposeDown('docker', ['compose', ...composeArgs]);
	if (!composeRan) {
		runComposeDown('docker-compose', composeArgs);
	}

	removeProjectResources(project);
}

// RUN COMPOSE DOWN ---
// Steps: spawn compose command, treat ENOENT as “binary missing”, treat non-zero exit as non-fatal so cleanup continues.
function runComposeDown(binary: string, argsList: string[]): boolean {
	// COMMAND EXEC ---
	// Steps: run with stdio passthrough so users see docker output; treat ENOENT as “binary not present”.
	const result = spawnSync(binary, argsList, { stdio: 'inherit' });
	if (result.error && isErrnoException(result.error) && result.error.code === 'ENOENT') {
		return false;
	}
	if (typeof result.status === 'number' && result.status !== 0) {
		console.warn(`Warning: '${binary} ${argsList.join(' ')}' exited with code ${result.status}. Continuing cleanup.`);
	}
	return true;
}

// REMOVE PROJECT RESOURCES ---
// Steps: remove containers/networks/volumes that match the project; prefer label filters, fall back to name filters, optionally prune safe volumes.
function removeProjectResources(project) {
	// CONTAINERS + NETWORKS ---
	// Steps: remove by compose label first (most precise), then name prefix (covers drift/older versions), then networks.
	removeResources(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], ['rm', '-f']);
	removeResources(['ps', '-aq', '--filter', `name=${project}-`], ['rm', '-f']);
	removeResources(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`], ['network', 'rm']);

	if (pruneVolumes) {
		// MYSQL VOLUME PROTECTION ---
		// Steps: collect MySQL volumes by name pattern and by container mounts to ensure data safety
		const volumeIds = listResources(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
		const mysqlVolumeIds = new Set<string>();

		// PROTECT VOLUMES BY NAME PATTERN ---
		// Steps: get all volumes with mysql in name (case-insensitive) and protect their IDs.
		const allVolumeNames = listResources(['volume', 'ls', '--format', '{{.Name}}']);
		const allVolumeIds = listResources(['volume', 'ls', '-q']);
		for (let i = 0; i < Math.min(allVolumeNames.length, allVolumeIds.length); i++) {
			const name = allVolumeNames[i].toLowerCase();
			if (name.includes('mysql')) {
				mysqlVolumeIds.add(allVolumeIds[i]);
			}
		}

		// PROTECT VOLUMES MOUNTED BY MYSQL CONTAINERS ---
		// Steps: inspect MySQL containers to find mounted volumes, protecting all MySQL data volumes.
		const mysqlContainerIds = listResources(['ps', '-aq', '--filter', 'name=mysql']);
		for (const containerId of mysqlContainerIds) {
			const inspectResult = spawnSync('docker', ['inspect', '--format', '{{range .Mounts}}{{if .Name}}{{.Name}}{{println}}{{end}}{{end}}', containerId], { encoding: 'utf8' });
			if (inspectResult.stdout) {
				const volumeNames = inspectResult.stdout
					.split(/\r?\n/)
					.map(line => line.trim())
					.filter(Boolean);
				for (const volumeName of volumeNames) {
					const volumeId = listResources(['volume', 'ls', '-q', '--filter', `name=^${volumeName}$`]);
					volumeId.forEach(id => mysqlVolumeIds.add(id));
				}
			}
		}

		// FILTER OUT MYSQL VOLUMES ---
		// Steps: remove MySQL volumes from deletion list to ensure data safety.
		const safeVolumeIds = volumeIds.filter(id => !mysqlVolumeIds.has(id));
		if (safeVolumeIds.length) {
			const ids = safeVolumeIds.filter(id => !removedIds.has(id));
			if (ids.length) {
				spawnSync('docker', ['volume', 'rm', ...dedupe(ids)], { stdio: 'inherit' });
				ids.forEach(id => removedIds.add(id));
			}
		}
	}
}

// REMOVE RESOURCES ---
// Steps: list current IDs, skip ones we already removed, then execute one docker remove command with deduped IDs.
function removeResources(listArgs, removeArgs) {
	// ID GATHER + DEDUPE ---
	// Steps: list current IDs, filter out already-removed ones (cross-project overlap), then execute one docker rm/rm-like call.
	const ids = listResources(listArgs).filter(id => !removedIds.has(id));
	if (!ids.length) {
		return;
	}

	spawnSync('docker', [...removeArgs, ...dedupe(ids)], { stdio: 'inherit' });
	ids.forEach(id => removedIds.add(id));
}

// LIST RESOURCES ---
// Steps: run docker listing command, parse stdout into trimmed IDs, return empty on missing docker or errors (best-effort cleanup).
function listResources(listArgs) {
	// DOCKER QUERY ---
	// Steps: run docker with stdout capture; if docker is missing or errors, treat as empty (cleanup is best-effort).
	const result = spawnSync('docker', listArgs, { encoding: 'utf8' });
	if (result.error && isErrnoException(result.error) && result.error.code === 'ENOENT') {
		return [];
	}
	if (result.status && result.status !== 0) {
		return [];
	}

	return result.stdout
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean);
}

// DEDUPE VALUES ---
// Steps: collapse duplicates so docker command args stay minimal and deterministic.
function dedupe(values) {
	// SET COLLAPSE ---
	// Steps: preserve semantics (order is irrelevant here) while preventing repeated docker args.
	return Array.from(new Set(values));
}

// ADD PROJECTS ---
// Steps: accept comma-separated tokens, recall this is called from both flags and positional args, and store into a Set for unique cleanup targets.
function addProjects(value) {
	if (!value) return;
	// TOKENIZE ---
	// Steps: allow comma-separated project names so callers can pass `--project=a,b` or positional `a,b`.
	value
		.split(',')
		.map(token => token.trim())
		.filter(Boolean)
		.forEach(name => projects.add(name));
}
