declare const process: { platform: string } | undefined;

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;
const PLATFORM = typeof process !== 'undefined' ? process.platform : 'linux';
const isWindows = PLATFORM === 'win32';

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

function fromWslPath(input: string): string | null {
  const forward = toForwardSlashes(input).replace(/^\/\/+/, '/');
  const match = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(forward);
  if (!match) return null;
  const [, drive, rest] = match;
  return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
}

function collapseSegments(parts: string[], allowAboveRoot: boolean): string[] {
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length > 0) {
        stack.pop();
      } else if (allowAboveRoot) {
        stack.push('..');
      }
      continue;
    }
    stack.push(part);
  }
  return stack;
}

interface WindowsSplit {
  prefix: string;
  segments: string[];
  kind: 'unc' | 'drive' | 'relative';
}

function splitWindowsPath(value: string): WindowsSplit {
  if (value.startsWith('\\\\')) {
    const trimmed = value.replace(/^\\\\/, '');
    const parts = trimmed.split(/\\+/).filter(Boolean);
    const host = parts.shift() || '';
    const share = parts.shift() || '';
    const prefix = `\\\\${host}${share ? `\\${share}` : ''}`;
    return { prefix, segments: parts, kind: 'unc' };
  }
  const driveMatch = /^([A-Za-z]):(.*)$/.exec(value);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/^\\+/, '');
    const segments = rest.split(/\\+/).filter(Boolean);
    return { prefix: `${drive}:`, segments, kind: 'drive' };
  }
  const trimmed = value.replace(/^\\+/, '');
  const segments = trimmed.split(/\\+/).filter(Boolean);
  return { prefix: '', segments, kind: 'relative' };
}

function normalizeWindowsPath(raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  const fromWsl = fromWslPath(value);
  if (fromWsl) value = fromWsl;
  value = value.replace(/\//g, '\\');
  value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\');
  value = value.replace(/^\\\\\?\\/, '');
  value = value.replace(/^([a-z])\:/, (_, letter) => `${letter.toUpperCase()}:`);
  const split = splitWindowsPath(value);
  const collapsed = collapseSegments(split.segments, split.kind === 'relative');
  if (split.kind === 'unc') {
    const suffix = collapsed.length ? `\\${collapsed.join('\\')}` : '';
    return `${split.prefix}${suffix}`;
  }
  if (split.kind === 'drive') {
    const suffix = collapsed.length ? `\\${collapsed.join('\\')}` : '';
    return `${split.prefix}${suffix || '\\'}`;
  }
  return collapsed.join('\\');
}

function normalizePosixPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const forward = toForwardSlashes(trimmed);
  const absolute = forward.startsWith('/');
  const parts = forward.split('/').filter(Boolean);
  const collapsed = collapseSegments(parts, !absolute);
  const body = collapsed.join('/');
  if (absolute) return '/' + body;
  return body;
}

function hasTraversal(raw: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(raw);
}

export const safetyPort = {
  async normalizePath(p: string): Promise<string> {
    if (typeof p !== 'string') {
      throw new TypeError('Path must be a string');
    }
    if (!p.trim()) return '';
    return isWindows ? normalizeWindowsPath(p) : normalizePosixPath(p);
  },

  async isSafe(p: string): Promise<boolean> {
    if (typeof p !== 'string') return false;
    const trimmed = p.trim();
    if (!trimmed) return false;
    if (hasTraversal(trimmed)) return false;

    if (isWindows) {
      const normalized = await this.normalizePath(trimmed);
      if (!normalized) return false;
      if (normalized.startsWith('\\\\?\\') || normalized.startsWith('\\\\.\\')) return false;
      if (normalized.startsWith('\\\\')) return false;
      if (!/^[A-Za-z]:\\/.test(normalized)) return false;
      const segments = normalized.split(/[\\/]+/).filter(Boolean);
      if (segments.length === 0) return false;
      const leaf = segments[segments.length - 1];
      if (WINDOWS_RESERVED.test(leaf)) return false;
      return true;
    }

    const normalizedPosix = normalizePosixPath(trimmed);
    if (!normalizedPosix.startsWith('/')) return false;
    return true;
  }
};
