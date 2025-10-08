// server.js
// Classroom manager prototype
// Node + Express wrapper that uses docker CLI to spawn per-student code-server containers.
//
// Notes:
// - Sanitize student names to avoid command injection.
// - Persists instances to instances.json so ports survive restarts (simple persistence).
// - Uses Docker CLI via child_process.exec. Make sure this Node process can run 'docker' (user in docker group or run with sudo).

const express = require('express');
const { exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------- Config ----------
const BASE_PORT = parseInt(process.env.BASE_PORT || '10000', 10);
const MANAGER_PORT = parseInt(process.env.MANAGER_PORT || '3000', 10);
const IMAGE = process.env.IMAGE || 'coder/code-server:4.16.0'; // change if you want another tag
const HOST_SHARED_DIR = path.resolve(__dirname, 'shared_resources');
const INSTANCES_FILE = path.resolve(__dirname, 'instances.json');
// resource limits per container (adjust as needed)
const MEM_LIMIT = process.env.MEM_LIMIT || '512m';
const CPU_LIMIT = process.env.CPU_LIMIT || '0.5';

// create shared folder if missing
if (!fs.existsSync(HOST_SHARED_DIR)) fs.mkdirSync(HOST_SHARED_DIR, { recursive: true });

// ---------- Persistence helpers ----------
function loadInstances() {
  try {
    if (fs.existsSync(INSTANCES_FILE)) {
      const raw = fs.readFileSync(INSTANCES_FILE, 'utf8');
      return JSON.parse(raw || '{}');
    }
    return {};
  } catch (e) {
    console.error('Failed to load instances.json', e);
    return {};
  }
}
function saveInstances(obj) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

let instances = loadInstances();

// compute nextPortOffset so we continue from highest used port
function computeNextPortOffset() {
  let maxPort = BASE_PORT - 1;
  for (const k of Object.keys(instances)) {
    const p = instances[k].port;
    if (p && Number(p) > maxPort) maxPort = Number(p);
  }
  return Math.max(0, maxPort - BASE_PORT + 1);
}
let nextPortOffset = computeNextPortOffset();

// ---------- Utility ----------
function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
function makePassword() {
  return crypto.randomBytes(6).toString('hex');
}
function sanitizeStudentName(name) {
  if (!name) throw new Error('empty name');
  let s = String(name).trim();
  // allow letters, numbers, hyphen, underscore; replace others with underscore
  s = s.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (s.length > 20) s = s.slice(0, 20);
  // avoid names starting with a number (container name rules)
  if (/^[0-9]/.test(s)) s = 's_' + s;
  return s;
}

// ---------- Docker operations ----------
async function spawnInstance(originalName, mountShared = false) {
  const safeName = sanitizeStudentName(originalName);
  if (instances[safeName]) throw new Error('Instance already exists: ' + safeName);

  const port = BASE_PORT + (nextPortOffset++);
  const password = makePassword();
  const volumeName = `student_${safeName}_vol`;
  const containerName = `student_${safeName}`;

  // create persistent volume
  await run(`docker volume create ${volumeName}`);

  // pull image first (fast if cached)
  await run(`docker pull ${IMAGE}`);

  // build mount for shared folder if requested
  const sharedArg = mountShared ? `-v "${HOST_SHARED_DIR}:/home/coder/shared:ro"` : '';
  // run container
  // set both PASSWORD and CODE_SERVER_PASSWORD envs to be robust across code-server versions
  const dockerRunCmd = [
    'docker run -d',
    `--name ${containerName}`,
    `-p ${port}:8080`,
    `-e PASSWORD=${password}`,
    `-e CODE_SERVER_PASSWORD=${password}`,
    `--memory=${MEM_LIMIT} --cpus=${CPU_LIMIT}`,
    `-v ${volumeName}:/home/coder/project`,
    sharedArg,
    `--restart no`, // don't auto-restart by default in prototype
    IMAGE
  ].filter(Boolean).join(' ');

  const { stdout } = await run(dockerRunCmd);
  const containerId = stdout.trim();

  instances[safeName] = {
    studentName: safeName,
    containerId,
    port,
    password,
    volume: volumeName,
    sharedMounted: !!mountShared,
    createdAt: new Date().toISOString()
  };
  saveInstances(instances);
  return instances[safeName];
}

async function stopInstance(studentName) {
  const safeName = sanitizeStudentName(studentName);
  const info = instances[safeName];
  if (!info) throw new Error('No such instance: ' + safeName);
  // stop & remove container (keep volume for persistence)
  await run(`docker stop ${info.containerId}`);
  await run(`docker rm ${info.containerId}`);
  delete instances[safeName];
  saveInstances(instances);
  return true;
}

// toggle shared by recreating container with same port & volume but shared mount toggled
async function toggleShared(studentName, shared) {
  const safeName = sanitizeStudentName(studentName);
  const info = instances[safeName];
  if (!info) throw new Error('Not allocated: ' + safeName);
  const pwd = info.password;
  const port = info.port;
  const volume = info.volume;
  const containerName = `student_${safeName}`;

  // stop & remove
  await run(`docker stop ${info.containerId}`);
  await run(`docker rm ${info.containerId}`);

  const sharedArg = shared ? `-v "${HOST_SHARED_DIR}:/home/coder/shared:ro"` : '';
  const dockerRunCmd = [
    'docker run -d',
    `--name ${containerName}`,
    `-p ${port}:8080`,
    `-e PASSWORD=${pwd}`,
    `-e CODE_SERVER_PASSWORD=${pwd}`,
    `--memory=${MEM_LIMIT} --cpus=${CPU_LIMIT}`,
    `-v ${volume}:/home/coder/project`,
    sharedArg,
    `--restart no`,
    IMAGE
  ].filter(Boolean).join(' ');

  const { stdout } = await run(dockerRunCmd);
  info.containerId = stdout.trim();
  info.sharedMounted = !!shared;
  saveInstances(instances);
  return info;
}

// ---------- Express routes ----------
app.get('/api/instances', (req, res) => {
  res.json(instances);
});

app.post('/api/create', async (req, res) => {
  try {
    const { studentName, shared } = req.body;
    if (!studentName) return res.status(400).json({ error: 'studentName required' });
    const inst = await spawnInstance(studentName, !!shared);
    res.json(inst);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e.stderr || e.message || e) });
  }
});

app.post('/api/stop', async (req, res) => {
  try {
    const { studentName } = req.body;
    if (!studentName) return res.status(400).json({ error: 'studentName required' });
    await stopInstance(studentName);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e.stderr || e.message || e) });
  }
});

app.post('/api/toggleShared', async (req, res) => {
  try {
    const { studentName, shared } = req.body;
    if (!studentName) return res.status(400).json({ error: 'studentName required' });
    const out = await toggleShared(studentName, !!shared);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: (e.stderr || e.message || e) });
  }
});

// simple health check
app.get('/api/ping', (req, res) => res.send('pong'));

// bind to 0.0.0.0 so other machines on LAN can reach it
const HOST = process.env.HOST || '0.0.0.0';
app.listen(MANAGER_PORT, HOST, () => {
  console.log(`Classroom manager listening on http://${HOST}:${MANAGER_PORT}`);
  console.log(`Base student ports start at ${BASE_PORT}`);
});
