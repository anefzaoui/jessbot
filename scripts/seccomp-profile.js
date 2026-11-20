// node scripts/seccomp-profile.js <docker's default.json> [out] — writes deploy/seccomp-chromium.json (#37).
// Docker's default seccomp profile (moby/profiles/seccomp/default.json, Apache-2.0) lets clone() and unshare() create
// namespaces only with CAP_SYS_ADMIN, and chroot() only with CAP_SYS_CHROOT; the Jessbot container drops every capability.
// Chromium's Linux sandbox, run as an unprivileged user, needs exactly those calls: it puts its renderers in their own
// user, PID and network namespaces and chroots them into an empty directory. This keeps every rule of Docker's profile
// as it is and adds one: chroot, clone, setns and unshare are allowed without those capabilities. The kernel still checks
// the capability inside the new user namespace; seccomp only decides whether the call may be made at all. clone3 keeps
// Docker's "not available" answer, so glibc falls back to clone. The container still keeps no capabilities
// (compose.yaml: cap_drop ALL, no-new-privileges).
import fs from 'node:fs';

const [src, out = 'deploy/seccomp-chromium.json'] = process.argv.slice(2);
if (!src) { console.error('usage: node scripts/seccomp-profile.js <moby default.json> [out]'); process.exit(2); }
const profile = JSON.parse(fs.readFileSync(src, 'utf8'));
if (!Array.isArray(profile.syscalls)) throw new Error('not a seccomp profile');
profile.syscalls.push({ names: ['chroot', 'clone', 'setns', 'unshare'], action: 'SCMP_ACT_ALLOW',
  comment: 'Jessbot: Chromium\'s namespace sandbox without CAP_SYS_ADMIN / CAP_SYS_CHROOT (#37, scripts/seccomp-profile.js)' });
fs.writeFileSync(out, `${JSON.stringify(profile, null, '\t')}\n`);
console.log(`wrote ${out} (${profile.syscalls.length} rules)`);
