// This machine's CPU, memory and load average for the status bar, after herdr-gpui's
// system_load, with recent CPU usage kept for a sparkline.
//
// Adapted from DanielFGray/herdr-config mods/usage/system.js (Apache-2.0), which read
// Linux's /proc only. Changed: one sampler per platform, picked by `forPlatform`:
//   linux   /proc (unchanged)
//   windows typeperf (built in): CPU utility as Task Manager shows it, available memory,
//           uptime; total memory and cores once, through PowerShell. Windows has no load
//           average, so LOAD is left out there.
//   macos   iostat (CPU split and load averages in one call), vm_stat (memory pages),
//           sysctl (total memory, cores, page size, boot time)
// Every sampler returns false when it cannot read (the bar then shows nothing for it),
// and never runs two reads at once.

/** CPU samples kept for the sparkline. */
export const HISTORY = 16;
export const INTERVAL = 2e3;

/** The sampler for `platform` ("linux" | "macos" | "windows"). */
export function forPlatform(platform, { readTextFile, exec }) {
  if (platform === "windows") return new WindowsLoad(exec);
  if (platform === "macos") return new MacLoad(exec);
  return new SystemLoad((path) => readTextFile(path));
}

class Sampler {
  constructor() {
    this.history = [];
    this.latest = null;
    this.busy = false;
  }

  /** Takes one sample; false when nothing could be read. */
  async sample() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const next = await this.read();
      if (!next) return false;
      if (next.cpu !== null) this.history = [...this.history, next.cpu].slice(-HISTORY);
      this.latest = next;
      return true;
    } catch {
      return false;
    } finally {
      this.busy = false;
    }
  }
}

// ---- Linux -------------------------------------------------------------------

export class SystemLoad extends Sampler {
  constructor(read) {
    super();
    this.readFile = read;
    this.ticks = null;
  }

  async read() {
    const [stat, meminfo, loadavg, uptime] = await Promise.all(["/proc/stat", "/proc/meminfo", "/proc/loadavg", "/proc/uptime"].map((p) => this.readFile(p).catch(() => null)));
    if (!stat || !meminfo) return null;
    const ticks = parseTicks(stat);
    // CPU usage is measured between two samples, so the first has none.
    const cpu = ticks && this.ticks ? usageSince(ticks, this.ticks) : null;
    this.ticks = ticks;
    return { cpu, cores: countCores(stat), memory: parseMemory(meminfo), load: loadavg ? parseLoad(loadavg) : null, uptime: uptime ? Math.floor(parseFloat(uptime)) : null };
  }
}

/** The `cpu` line of /proc/stat: `user nice system idle iowait irq softirq steal …`; guest time is already in user time, so only the first eight columns add up. */
export function parseTicks(stat) {
  const line = stat.split("\n").find((l) => l.startsWith("cpu "));
  const columns = line?.slice(4).trim().split(/\s+/).slice(0, 8).map(Number);
  if (!columns || columns.length < 4 || columns.some(Number.isNaN)) return null;
  const total = columns.reduce((a, b) => a + b, 0);
  return { busy: total - columns[3] - (columns[4] ?? 0), total };
}

/** Share of all cores busy between two samples, 0..100; null if the counters went backwards. */
export function usageSince(now, previous) {
  const total = now.total - previous.total;
  const busy = now.busy - previous.busy;
  if (total <= 0 || busy < 0) return null;
  return clamp(busy / total * 100);
}

/** Bytes in use: total less available, as `free` and sysinfo count it. */
export function parseMemory(meminfo) {
  const kb = (key) => Number(meminfo.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1]);
  const total = kb("MemTotal") * 1024;
  const available = kb("MemAvailable") * 1024;
  return total > 0 && available >= 0 ? { used: total - available, total } : null;
}

export function parseLoad(loadavg) {
  const load = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  return load.length === 3 && !load.some(Number.isNaN) ? load : null;
}

function countCores(stat) {
  return stat.split("\n").filter((l) => /^cpu\d+ /.test(l)).length || null;
}

// ---- Windows -----------------------------------------------------------------

// English counter names work on every display language (checked on ru-RU).
const COUNTERS = ["\\Processor Information(_Total)\\% Processor Utility", "\\Memory\\Available Bytes", "\\System\\System Up Time"];

export class WindowsLoad extends Sampler {
  constructor(exec) {
    super();
    this.exec = exec;
    this.machine = null;
  }

  async read() {
    // typeperf averages over its one-second sample, so each read is a fresh CPU figure.
    const [r, machine] = await Promise.all([this.exec("typeperf", [...COUNTERS, "-sc", "1"]), this.machineInfo()]);
    const row = parseTypeperf(r.stdout);
    if (!row || row.length < 3) return null;
    const [cpu, available, up] = row;
    const total = machine.memory;
    return {
      cpu: Number.isFinite(cpu) ? clamp(cpu) : null,
      cores: machine.cores,
      memory: total && Number.isFinite(available) ? { used: Math.max(0, total - available), total } : null,
      load: null,
      uptime: Number.isFinite(up) ? Math.floor(up) : null,
    };
  }

  /** Total memory and core count never change: asked once. */
  async machineInfo() {
    if (this.machine) return this.machine;
    let memory = null, cores = null;
    try {
      const r = await this.exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; [Environment]::ProcessorCount"]);
      [memory, cores] = r.stdout.trim().split(/\s+/).map(Number);
    } catch {}
    this.machine = { memory: memory > 0 ? memory : null, cores: cores > 0 ? cores : null };
    return this.machine;
  }
}

/** The data row of typeperf's CSV: `"time","12.5","1834…","8385…"` → [12.5, 1834…, 8385…]. */
export function parseTypeperf(stdout) {
  const line = String(stdout).split(/\r?\n/).find((l) => l.startsWith('"') && !l.startsWith('"(PDH'));
  if (!line) return null;
  // Fields are quoted; a comma inside one is a decimal comma (some locales).
  return line.trim().replace(/^"|"$/g, "").split('","').slice(1).map((f) => Number(f.replace(",", ".")));
}

// ---- macOS -------------------------------------------------------------------

export class MacLoad extends Sampler {
  constructor(exec) {
    super();
    this.exec = exec;
    this.machine = null;
  }

  async read() {
    // `iostat -n 0`: no disks, just "us sy id 1m 5m 15m". The first report is since boot;
    // the second covers the last second, so that one is the CPU figure.
    const [io, vm, machine] = await Promise.all([this.exec("iostat", ["-n", "0", "-c", "2", "-w", "1"]), this.exec("vm_stat", []), this.machineInfo()]);
    const cpuLoad = parseIostat(io.stdout);
    const memory = machine.memory ? parseVmStat(vm.stdout, machine.memory) : null;
    if (!cpuLoad && !memory) return null;
    return {
      cpu: cpuLoad?.cpu ?? null,
      cores: machine.cores,
      memory,
      load: cpuLoad?.load ?? null,
      uptime: machine.boot ? Math.floor(Date.now() / 1000 - machine.boot) : null,
    };
  }

  async machineInfo() {
    if (this.machine) return this.machine;
    let memory = null, cores = null, boot = null;
    try {
      const r = await this.exec("sysctl", ["-n", "hw.memsize", "hw.ncpu", "kern.boottime"]);
      const [mem, cpus, ...rest] = r.stdout.trim().split(/\r?\n/);
      memory = Number(mem) > 0 ? Number(mem) : null;
      cores = Number(cpus) > 0 ? Number(cpus) : null;
      boot = Number(/sec\s*=\s*(\d+)/.exec(rest.join(" "))?.[1]) || null;
    } catch {}
    this.machine = { memory, cores, boot };
    return this.machine;
  }
}

/** The last line of `iostat -n 0 -c 2`: us sy id l1 l5 l15. */
export function parseIostat(stdout) {
  const rows = String(stdout).trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length >= 6 && !r.some(Number.isNaN));
  const last = rows[rows.length - 1];
  if (!last) return null;
  const [us, sy, id, l1, l5, l15] = last.slice(-6);
  return { cpu: clamp(100 - id), load: [l1, l5, l15], split: { us, sy } };
}

/** Memory in use as Activity Monitor counts it: app memory + wired + compressed. */
export function parseVmStat(stdout, total) {
  const text = String(stdout);
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]) || 4096;
  const pages = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text)?.[1]);
  const anonymous = pages("Anonymous pages");
  const purgeable = pages("Pages purgeable") || 0;
  const wired = pages("Pages wired down");
  const compressed = pages("Pages occupied by compressor") || 0;
  const active = pages("Pages active");
  if (!Number.isFinite(wired)) return null;
  const app = Number.isFinite(anonymous) ? anonymous - purgeable : active;
  if (!Number.isFinite(app)) return null;
  const used = (app + wired + compressed) * pageSize;
  return { used: Math.min(total, Math.max(0, used)), total };
}

// ---- shared ------------------------------------------------------------------

const clamp = (v) => Math.min(100, Math.max(0, v));

export const memoryPercent = (m) => clamp((m.used / m.total) * 100);

/** Binary gigabytes, as `free -h` counts them: "7.0 GB". */
export const gigabytes = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/** How long the machine has been up, in its two largest units: "116d 0h", "3h 12m", "12m". */
export function uptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}
