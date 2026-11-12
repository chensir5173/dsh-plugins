// Test fixture: non-zero exit with a message on stderr.
process.stderr.write('boom')
process.exit(3)
