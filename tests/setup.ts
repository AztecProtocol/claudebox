// Test environment setup — must be loaded before any libclaudebox imports.
// Node test runner's --import flag ensures this runs first.

process.env.CLAUDEBOX_SESSION_PASS = "test-pass";
process.env.CLAUDEBOX_LOG_BASE_URL = "http://ci.example.com";
process.env.CLAUDEBOX_HOST = "claudebox.test";
process.env.CLAUDEBOX_DEFAULT_BRANCH = "main";
process.env.CLAUDEBOX_SESSION_USER = "testadmin";
