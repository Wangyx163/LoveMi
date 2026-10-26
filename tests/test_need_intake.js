'use strict';
// V2.2: one combined clarification, never NEED_WAIT.
require('./v22_flow').run('NEED：').catch(e=>{console.error(e);process.exitCode=1});
