// Shared state for the Spotify job (direct or API). The popup renders it from storage.
export const ctl = { running: false, cancelled: false };
let job = null;
export const J = () => job;
export const save = () => chrome.storage.local.set({ job });
export async function startJob(init) {
  job = { state: "run", i: 0, total: 0, added: 0, dup: 0, missed: [], failed: [], log: [], ...init };
  await save();
  return job;
}
export const patch = (p) => { Object.assign(job, p); return save(); };
export function note(text, state = "run") {
  const last = job.log[job.log.length - 1];
  if (last && last.text === text && last.state === "run") last.state = state;
  else job.log.push({ text, state });
  if (job.log.length > 40) job.log.shift();
  save();
}
