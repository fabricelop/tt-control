const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const baseDir = __dirname;
const repoDir = path.join(baseDir, '..');
const sourceFile = path.join(baseDir, 'debug', 'results.json');
const reportFile = path.join(baseDir, 'search-report.json');
const reportRepoPath = 'selorecordamos/search-report.json';

function runGit(args) {
  return cp.execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
}

function gitStatus(args) {
  return cp.spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' });
}

function ensureCleanRebaseState() {
  const gitDir = runGit(['rev-parse', '--git-dir']).trim();
  const absGitDir = path.resolve(repoDir, gitDir);
  const rebaseMerge = path.join(absGitDir, 'rebase-merge');
  const rebaseApply = path.join(absGitDir, 'rebase-apply');

  if (!fs.existsSync(rebaseMerge) && !fs.existsSync(rebaseApply)) return;

  const abort = gitStatus(['rebase', '--abort']);
  if (abort.status === 0) {
    console.log('Rebase Git incompleto detectado y abortado antes de publicar el informe.');
    return;
  }

  const quit = gitStatus(['rebase', '--quit']);
  if (quit.status === 0) {
    console.log('Estado residual de rebase limpiado antes de publicar el informe.');
    return;
  }

  throw new Error('Hay un rebase Git incompleto y no se pudo limpiar automaticamente.');
}

function ensureMainBranch() {
  const branch = gitStatus(['symbolic-ref', '--short', '-q', 'HEAD']);
  const current = branch.status === 0 ? branch.stdout.trim() : '';
  if (current === 'main') return;

  const sw = gitStatus(['switch', 'main']);
  if (sw.status !== 0) {
    throw new Error('El repositorio local no esta en main y no se pudo cambiar automaticamente a main: ' + (sw.stderr || sw.stdout || '').trim());
  }
  console.log('Repositorio local cambiado automaticamente a main antes de publicar el informe.');
}

if (!fs.existsSync(sourceFile)) {
  console.log('No hay debug/results.json; no se publica informe de búsqueda.');
  process.exit(0);
}

// Ajustes editoriales posteriores al filtro base: promociones muy acotadas y
// recuperaciones puntuales. Se ejecuta antes de publicar el informe y antes
// de que run-search.ps1 envíe el outbox a Telegram.
cp.execFileSync(process.execPath, [path.join(baseDir, 'postprocess_search.js')], { cwd: repoDir, stdio: 'inherit' });

const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
const report = {
  generated_at: new Date().toISOString(),
  fetched_at: source.fetched_at || null,
  mode: source.mode || null,
  query: source.query || null,
  status: source.status || null,
  note: source.note || null,
  extracted: Number(source.extracted || 0),
  already_seen: Number(source.already_seen || 0),
  new_found: [
    ...(Array.isArray(source.candidates) ? source.candidates.map(t => ({ ...t, filter_status: 'candidate' })) : []),
    ...(Array.isArray(source.rejected) ? source.rejected.map(t => ({ ...t, filter_status: 'rejected' })) : [])
  ]
};

fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', 'utf8');

try {
  // Robustez: un rebase antiguo o detached HEAD no debe bloquear para siempre
  // las ejecuciones horarias de SeLoRecordamos.
  ensureCleanRebaseState();
  ensureMainBranch();

  runGit(['add', reportRepoPath]);
  const diff = cp.spawnSync('git', ['diff', '--cached', '--quiet', '--', reportRepoPath], { cwd: repoDir });
  if (diff.status === 0) {
    console.log('Informe de búsqueda sin cambios.');
    process.exit(0);
  }

  runGit(['commit', '-m', 'Update SeLoRecordamos search report', '--', reportRepoPath]);

  try {
    runGit(['push', 'origin', 'main']);
  } catch (_) {
    // Si main avanzo en remoto, sincronizamos y reintentamos. Si hubiera
    // quedado otro rebase residual, la siguiente ejecucion lo limpiara.
    runGit(['pull', '--rebase', '--autostash', 'origin', 'main']);
    runGit(['push', 'origin', 'main']);
  }

  console.log('Informe de búsqueda SeLoRecordamos subido a GitHub.');
} catch (e) {
  console.error('No se pudo publicar el informe de búsqueda:', String(e.stderr || e.message || e).trim());
  process.exit(1);
}
