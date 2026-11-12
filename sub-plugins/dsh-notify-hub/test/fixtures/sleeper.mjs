// Test fixture: outlives any sane timeout, so the executor must kill it.
setTimeout(() => {}, 60000)
