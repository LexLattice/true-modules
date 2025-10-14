function tmError(code, message) {
  const err = new Error(`${code} ${message}`);
  err.code = code;
  return err;
}

function normalizePortName(portId) {
  return (portId || '').split('@')[0];
}

function parsePortId(portId) {
  const [name, rawVersion] = String(portId || '').split('@');
  const versionPart = rawVersion && rawVersion.length ? rawVersion : '1';
  const major = versionPart.split('.')[0] || '1';
  return { name, version: versionPart, major };
}

function portMajorId(portId) {
  const parsed = parsePortId(portId);
  if (!parsed.name) {
    throw tmError('E_COMPOSE', `Invalid port identifier: ${portId}`);
  }
  return `${parsed.name}@${parsed.major}`;
}

function extractPreferredProviders(constraints = []) {
  const preferred = new Map();
  for (const constraint of constraints) {
    if (!constraint) continue;
    if (typeof constraint === 'string') {
      const trimmed = constraint.trim();
      const match = /^prefer:([A-Za-z][A-Za-z0-9]*Port@\d+)=([a-z][a-z0-9_.-]+)$/.exec(trimmed);
      if (match) {
        const [, port, module] = match;
        const prev = preferred.get(port);
        if (prev && prev !== module) {
          throw tmError('E_PREFER_UNSAT', `Conflicting preferred providers for ${port}: ${prev} vs ${module}`);
        }
        preferred.set(port, module);
      }
      continue;
    }
    if (typeof constraint === 'object' && !Array.isArray(constraint) && constraint.preferred_providers) {
      for (const [port, module] of Object.entries(constraint.preferred_providers)) {
        const prev = preferred.get(port);
        if (prev && prev !== module) {
          throw tmError('E_PREFER_UNSAT', `Conflicting preferred providers for ${port}: ${prev} vs ${module}`);
        }
        preferred.set(port, module);
      }
    }
  }
  return preferred;
}

function normalizeModuleEntries(moduleEntries) {
  if (moduleEntries instanceof Map) return moduleEntries;
  return new Map(Object.entries(moduleEntries));
}

function toManifest(entry) {
  if (!entry) return entry;
  return entry.manifest ?? entry;
}

export function analyzeProviders(compose, moduleEntriesInput) {
  const moduleEntries = normalizeModuleEntries(moduleEntriesInput);
  const infoMap = new Map();
  const modulePortIndex = new Map();
  const basePortMajors = new Map();

  for (const [moduleId, entry] of moduleEntries.entries()) {
    const manifest = toManifest(entry);
    if (!manifest) continue;
    const portMap = new Map();
    for (const portId of manifest.provides || []) {
      const major = portMajorId(portId);
      const name = normalizePortName(portId);
      if (!infoMap.has(major)) {
        infoMap.set(major, {
          port: major,
          providers: new Set(),
          chosen: null,
          reason: null
        });
      }
      infoMap.get(major).providers.add(moduleId);
      if (!portMap.has(name)) portMap.set(name, []);
      portMap.get(name).push(major);
      if (!basePortMajors.has(name)) basePortMajors.set(name, new Set());
      basePortMajors.get(name).add(major);
    }
    modulePortIndex.set(moduleId, portMap);
  }

  const preferred = extractPreferredProviders(compose.constraints || []);
  const moduleIds = new Set(moduleEntries.keys());

  for (const [port, moduleId] of preferred.entries()) {
    const info = infoMap.get(port);
    if (!info) {
      throw tmError('E_PREFER_UNSAT', `Preferred provider for ${port} not present in compose plan.`);
    }
    if (!moduleIds.has(moduleId)) {
      throw tmError('E_PREFER_UNSAT', `Preferred provider ${moduleId} for ${port} is not part of the compose modules.`);
    }
    if (!info.providers.has(moduleId)) {
      throw tmError('E_PREFER_UNSAT', `Preferred provider ${moduleId} does not supply ${port}.`);
    }
  }

  const warnings = [];

  for (const w of compose.wiring || []) {
    if (!w) continue;
    const [fromModule, fromPort] = String(w.from || '').split(':');
    const [toModule, toPort] = String(w.to || '').split(':');
    if (!fromModule || !fromPort || !toModule || !toPort) continue;
    let moduleId = null;
    let portName = null;
    if (fromModule !== 'orchestrator' && toModule === 'orchestrator') {
      moduleId = fromModule;
      portName = fromPort;
    } else if (toModule !== 'orchestrator' && fromModule === 'orchestrator') {
      moduleId = toModule;
      portName = toPort;
    } else {
      continue;
    }
    if (!moduleEntries.has(moduleId)) continue;
    const candidates = (modulePortIndex.get(moduleId)?.get(portName)) || [];
    if (candidates.length === 0) {
      throw tmError('E_COMPOSE', `Module ${moduleId} does not provide port ${portName}`);
    }
    if (candidates.length > 1) {
      throw tmError('E_COMPOSE', `Module ${moduleId} provides multiple majors for port ${portName}; wiring must disambiguate via constraints.`);
    }
    const port = candidates[0];
    const info = infoMap.get(port);
    if (!info) continue;
    if (info.chosen && info.chosen !== moduleId) {
      throw tmError('E_DUP_PROVIDER', `Conflicting wiring for ${port}: ${info.chosen} vs ${moduleId}`);
    }
    info.chosen = moduleId;
    info.reason = 'wired';
  }

  for (const [port, moduleId] of preferred.entries()) {
    const info = infoMap.get(port);
    if (!info) continue;
    if (info.reason === 'wired') {
      if (info.chosen !== moduleId) {
        warnings.push(`Preference for ${port}=${moduleId} ignored because wiring selected ${info.chosen}.`);
      }
      continue;
    }
    info.chosen = moduleId;
    info.reason = 'preferred';
  }

  const unresolved = [];
  for (const info of infoMap.values()) {
    info.providers = Array.from(info.providers).sort();
    if (!info.chosen) {
      if (info.providers.length === 1) {
        info.chosen = info.providers[0];
        info.reason = 'sole';
      } else if (info.providers.length > 1) {
        unresolved.push(info);
      }
    }
  }

  if (unresolved.length) {
    const target = unresolved.sort((a, b) => a.port.localeCompare(b.port))[0];
    const msg = `Duplicate providers for ${target.port}: ${target.providers.join(', ')}.\nAdd wiring from orchestrator or constraint prefer:${target.port}=${target.providers[0]}.`;
    throw tmError('E_DUP_PROVIDER', msg);
  }

  const versionAmbiguities = [];
  for (const [basePort, majorsSet] of basePortMajors.entries()) {
    if (!majorsSet || majorsSet.size <= 1) continue;
    const majors = Array.from(majorsSet).sort();
    const infos = majors.map(id => infoMap.get(id)).filter(Boolean);
    const selected = infos.filter(info => info.reason === 'wired' || info.reason === 'preferred');
    if (selected.length === 0) {
      versionAmbiguities.push({
        base: basePort,
        majors,
        message: `Multiple majors for ${basePort}: ${majors.join(', ')}. Add orchestrator wiring or preferred_providers entry targeting the desired major.`
      });
      continue;
    }
    if (selected.length > 1) {
      const detail = selected.map(info => `${info.port}=${info.chosen}`).join(', ');
      versionAmbiguities.push({
        base: basePort,
        majors,
        message: `Conflicting majors for ${basePort}: ${detail}. Ensure a single major is selected via wiring or preferred_providers.`
      });
      continue;
    }
    const active = selected[0];
    for (const info of infos) {
      if (info === active) continue;
      const leftovers = info.providers.filter(p => p !== active.chosen);
      info.reason = 'inactive';
      info.chosen = null;
      if (leftovers.length) {
        warnings.push(`Major ${info.port} skipped because ${active.chosen} was selected for ${basePort}; remaining providers: ${info.providers.join(', ')}.`);
      } else {
        warnings.push(`Major ${info.port} skipped because ${active.chosen} was selected for ${basePort}.`);
      }
    }
  }

  if (versionAmbiguities.length) {
    const first = versionAmbiguities.sort((a, b) => a.base.localeCompare(b.base))[0];
    throw tmError('E_PORT_VERSION_AMBIG', first.message);
  }

  for (const info of infoMap.values()) {
    if (info.reason === 'preferred' && info.providers.length > 1) {
      const leftovers = info.providers.filter(p => p !== info.chosen);
      if (leftovers.length) {
        warnings.push(`Preferred provider for ${info.port} selected ${info.chosen}; remaining providers: ${leftovers.join(', ')}`);
      }
    }
  }

  const explanations = Array.from(infoMap.values())
    .map(info => ({
      port: info.port,
      provider: info.chosen,
      reason: info.reason,
      candidates: info.providers
    }))
    .sort((a, b) => a.port.localeCompare(b.port));

  return { explanations, warnings };
}

export { tmError };
