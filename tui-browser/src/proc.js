'use strict';

// Whether a process id recorded earlier still belongs to a running process.
//
// Signal 0 performs the permission and existence checks without delivering
// anything. EPERM means the process is there and simply is not ours, which
// still counts as running — only ESRCH means it is gone.
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

module.exports = { processAlive };
