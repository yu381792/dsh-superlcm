import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const initialSettings = {
  summaryEnabled: false, summaryProvider: 'summary-provider', summaryModel: 'summary-1',
  chunkTokens: 20000, fanout: 4, takeover: false,
  compactionProvider: 'compression-provider', compactionModel: 'compression-1',
  compressionRatio: 0.8, compressionChunkTokens: 20000,
};
const catalog = [
  { id: 'summary-provider', label: '摘要供应商', models: [
    { id: 'summary-1', label: '摘要模型一' }, { id: 'summary-2', label: '摘要模型二' },
  ] },
  { id: 'compression-provider', label: '压缩供应商', models: [
    { id: 'compression-1', label: '压缩模型一' }, { id: 'compression-2', label: '压缩模型二' },
  ] },
];
// Render the actual bundle with isolated hook state and explicit effect cleanup.
// All transport responses are local fixtures; unknown operations fail the test.
function createClient({ settings = {}, runtime = {} } = {}) {
  const instances = new Map(), calls = [];
  let active, hookIndex, effects = [], mounted = new Set(), tree, bundle, Form, registration;
  let snapshot = {
    version: 'test', revision: 1, settings: { ...initialSettings, ...settings }, catalog,
    runtime: { takeover: false, mode: 'native', archive: true, ...runtime },
  };
  let saveError = null;
  const disposeInstance = (instance) => {
    for (const hook of instance.hooks) hook?.cleanup?.();
  };
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children }, children };
    },
    useState(initial) {
      const instance = active, index = hookIndex++;
      if (!(index in instance.hooks)) instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [instance.hooks[index], (value) => {
        instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value;
      }];
    },
    useRef(value) { const index = hookIndex++; return active.hooks[index] ||= { current: value }; },
    useEffect(effect, dependencies) {
      const instance = active, index = hookIndex++, previous = instance.hooks[index];
      if (!previous || dependencies.length !== previous.dependencies.length ||
        dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          instance.hooks[index] = { dependencies, cleanup: effect() };
        });
      }
    },
  };
  const connection = { rpc: { async call(path, method, payload) {
    assert.equal(path, '/api');
    assert.match(method, /^dsh-superlcm\//);
    calls.push({ method: method.slice('dsh-superlcm/'.length), payload: structuredClone(payload) });
    switch (calls.at(-1).method) {
      case 'read': return { ok: true, value: structuredClone(snapshot) };
      case 'save':
        if (saveError) return { ok: false, error: saveError };
        assert.equal(payload.revision, snapshot.revision);
        snapshot = { ...snapshot, revision: snapshot.revision + 1, settings: structuredClone(payload.settings),
          runtime: { ...snapshot.runtime, takeover: payload.settings.takeover, mode: payload.settings.takeover ? 'superlcm' : 'native' } };
        return { ok: true, value: structuredClone(snapshot) };
      default: assert.fail(`Unexpected operation: ${method}`);
    }
  } } };
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { assert.equal(bundle, undefined); bundle = value; } } },
  }, { filename: 'lib/client.js' });
  assert.equal(bundle.id, 'SuperLcm');
  const plugin = bundle.factory((id) => { assert.equal(id, 'react'); return React; });
  assert.deepEqual(Array.from(plugin.inject), ['slots', 'connection']);
  plugin.apply({ connection, slots: {
    inject(name, factory) { assert.equal(name, 'plugins.bundle.config'); factory(); },
    register(definition, component) { registration = definition; Form = component; },
  } });
  assert.equal(registration.name, 'plugins.bundle.config');
  assert.equal(registration.key, 'SuperLcm');
  assert.equal(registration.inject().connection, connection);

  function expand(element, path) {
    if (element === false || element == null) return null;
    if (Array.isArray(element)) return element.map((item, i) => expand(item, `${path}.${i}`));
    if (typeof element !== 'object') return element;
    if (typeof element.type === 'function') {
      let instance = instances.get(path);
      if (!instance || instance.type !== element.type) {
        if (instance) disposeInstance(instance);
        instance = { type: element.type, hooks: [] }; instances.set(path, instance);
      }
      mounted.add(path); active = instance; hookIndex = 0;
      return expand(element.type(element.props), path + '.rendered');
    }
    return { ...element, children: element.children.map((child, i) => expand(child, `${path}.${i}`)) };
  }
  function render() {
    effects = []; mounted = new Set();
    tree = expand(React.createElement(Form, { connection }), 'root');
    for (const [path, instance] of instances) {
      if (!mounted.has(path)) { disposeInstance(instance); instances.delete(path); }
    }
    for (const effect of effects) effect();
  }
  function nodes(node = tree) {
    if (Array.isArray(node)) return node.flatMap((child) => nodes(child));
    if (!node || typeof node !== 'object') return [];
    return [node, ...node.children.flatMap((child) => nodes(child))];
  }
  function text(node = tree) {
    if (Array.isArray(node)) return node.map((child) => text(child)).join('');
    if (node == null || node === false) return '';
    return typeof node === 'object' ? node.children.map((child) => text(child)).join('') : String(node);
  }
  const find = (predicate, description) => {
    const result = nodes().find(predicate); assert.ok(result, `Missing ${description}`); return result;
  };
  const button = (label, index = 0) => {
    const result = nodes().filter((node) => node.type === 'button' && text(node) === label)[index];
    assert.ok(result, `Missing button ${label} at index ${index}`); return result;
  };
  async function settle() {
    // Drain promises and re-render effects without clocks, external services or real React.
    for (let i = 0; i < 4; i++) { await new Promise(setImmediate); render(); }
  }
  async function click(label, index) {
    const node = button(label, index); assert.ok(!node.props.disabled, `Disabled button ${label}`);
    node.props.onClick(); await settle();
  }
  async function change(label, value, type = 'input') {
    const node = find((item) => item.type === type && item.props['aria-label'] === label, label);
    assert.ok(!node.props.disabled); node.props.onChange({ target: { value: String(value) } }); await settle();
  }
  async function toggle(label, checked) {
    const container = find((node) => node.type === 'label' && text(node) === label, label);
    const input = nodes(container).find((node) => node.type === 'input' && node.props.type === 'checkbox');
    assert.ok(input && !input.props.disabled); input.props.onChange({ target: { checked } }); await settle();
  }
  render();
  return {
    plugin, registration, connection, calls, button, nodes, text,
    settle, click, change, toggle,
    get snapshot() { return snapshot; },
    get lastSave() { return calls.filter((call) => call.method === 'save').at(-1)?.payload; },
    failSave(error) { saveError = error; },
    setRevision(revision) { snapshot = { ...snapshot, revision }; },
    dispose() { for (const instance of instances.values()) disposeInstance(instance); instances.clear(); },
  };
}

async function mount(t, options) {
  const app = createClient(options); t.after(() => app.dispose()); await app.settle(); return app;
}

test('native plugin registers the actual client with the authenticated host connection', async (t) => {
  const app = await mount(t);
  assert.equal(app.registration.inject().connection, app.connection);
  assert.equal(app.calls[0].method, 'read');
  assert.match(app.text(), /摘要设置压缩/);
  assert.deepEqual(app.nodes().filter(node=>node.props?.role==='tab').map(node=>app.text(node)),['摘要设置','压缩']);
  assert.match(app.text(), /启用后台分层摘要/);
  assert.deepEqual(app.calls.map((call) => call.method), ['read']);
  await app.click('压缩');
  assert.deepEqual(app.calls.map((call) => call.method), ['read']);
});

test('summary and compression retain independent switches, models and chunk sizes', async (t) => {
  const app = await mount(t);
  await app.click('摘要设置'); await app.toggle('启用后台分层摘要', true);
  await app.change('模型', 'summary-2', 'select'); await app.click('40 K Token'); await app.click('保存');
  assert.equal(app.lastSave.settings.summaryEnabled, true);
  assert.equal(app.lastSave.settings.summaryModel, 'summary-2');
  assert.equal(app.lastSave.settings.chunkTokens, 40000);
  assert.equal(app.lastSave.settings.takeover, false);
  assert.equal(app.lastSave.settings.compactionModel, 'compression-1');
  assert.equal(app.lastSave.settings.compressionChunkTokens, 20000);

  await app.click('压缩'); await app.toggle('由 SuperLcm 接管上下文压缩', true);
  await app.change('模型', 'compression-2', 'select'); await app.click('90 %'); await app.click('10 K Token'); await app.click('保存');
  assert.equal(app.lastSave.settings.takeover, true);
  assert.equal(app.lastSave.settings.compactionModel, 'compression-2');
  assert.equal(app.lastSave.settings.compressionRatio, 0.9);
  assert.equal(app.lastSave.settings.compressionChunkTokens, 10000);
  assert.equal(app.lastSave.settings.summaryEnabled, true);
  assert.equal(app.lastSave.settings.summaryModel, 'summary-2');
  assert.equal(app.lastSave.settings.chunkTokens, 40000);

  await app.click('摘要设置'); await app.toggle('启用后台分层摘要', false); await app.click('保存');
  assert.equal(app.lastSave.settings.summaryEnabled, false);
  assert.equal(app.lastSave.settings.takeover, true);
  await app.click('压缩'); await app.toggle('由 SuperLcm 接管上下文压缩', false); await app.click('保存');
  assert.equal(app.lastSave.settings.summaryEnabled, false);
  assert.equal(app.lastSave.settings.takeover, false);
});

test('disabling takeover hides its status badge and retained runtime error immediately and after save', async (t) => {
  const app = await mount(t, { settings: { takeover: true }, runtime: { takeover: true, mode: 'superlcm', lastError: '宿主接管故障提醒' } });
  await app.click('压缩');
  assert.match(app.text(), /SuperLcm 正在接管/);
  assert.match(app.text(), /宿主接管故障提醒/);
  await app.toggle('由 SuperLcm 接管上下文压缩', false);
  assert.doesNotMatch(app.text(), /正在接管|等待保存后接管|宿主接管故障提醒/);
  await app.click('保存');
  assert.equal(app.snapshot.runtime.lastError, '宿主接管故障提醒');
  assert.doesNotMatch(app.text(), /正在接管|等待保存后接管|宿主接管故障提醒/);
});

test('background archive failures are visible in both tabs even when takeover is off', async (t) => {
  const app = await mount(t, { settings: { takeover: false }, runtime: { takeover: false, mode: 'native',
    lastError: '会话来源信息冲突（HEADER_IDENTITY）。原文保留。', lastDiagnostic: { stage: 'capture', code: 'HEADER_IDENTITY' } } });
  assert.match(app.text(), /HEADER_IDENTITY/);
  await app.click('压缩');assert.match(app.text(), /HEADER_IDENTITY/);
  assert.doesNotMatch(app.text(), /正在接管|等待保存后接管/);
});

test('custom K Token values and integer percentages save in server units and invalid values stay local', async (t) => {
  const app = await mount(t);
  await app.click('摘要设置'); await app.click('自定义'); await app.change('每个摘要分块', 32);
  await app.change('每次合并的摘要段数', 8); await app.click('保存');
  assert.equal(app.lastSave.settings.chunkTokens, 32000);
  assert.equal(app.lastSave.settings.fanout, 8);
  await app.click('压缩'); await app.click('自定义', 0); await app.change('压缩比例', 75);
  await app.click('自定义', 1); await app.change('每个压缩分块', 28); await app.click('保存');
  assert.equal(app.lastSave.settings.compressionRatio, 0.75);
  assert.equal(app.lastSave.settings.compressionChunkTokens, 28000);

  const saveCount = () => app.calls.filter((call) => call.method === 'save').length;
  const before = saveCount();
  for (const value of [0, 100, 75.5, '']) {
    await app.change('压缩比例', value); await app.click('保存');
    assert.equal(saveCount(), before); assert.match(app.text(), /1% 至 99%/);
  }
  await app.change('压缩比例', 75);
  for (const value of [0, 4001, 20.5, '']) {
    await app.change('每个压缩分块', value); await app.click('保存');
    assert.equal(saveCount(), before); assert.match(app.text(), /1 至 4,000 K Token/);
  }
});

test('failed save preserves the draft and retry sends the same edited values', async (t) => {
  const app = await mount(t);
  await app.click('摘要设置'); await app.click('40 K Token'); await app.change('模型', 'summary-2', 'select');
  app.failSave({ code: 'OFFLINE', message: '连接暂时中断' }); await app.click('保存');
  assert.match(app.text(), /连接暂时中断.*当前草稿已保留/);
  assert.equal(app.button('40 K Token').props['aria-pressed'], true);
  assert.equal(app.nodes().find((node) => node.type === 'select' && node.props['aria-label'] === '模型').props.value, 'summary-2');
  assert.equal(app.snapshot.settings.chunkTokens, 20000);
  const failedSettings = app.lastSave.settings;
  app.failSave(null); await app.click('保存');
  assert.deepEqual(app.lastSave.settings, failedSettings);
  assert.equal(app.snapshot.settings.chunkTokens, 40000);
  assert.match(app.text(), /设置已保存/);
});

test('revision conflict refreshes the revision while retaining the local draft', async (t) => {
  const app = await mount(t);
  await app.click('摘要设置'); await app.click('10 K Token');
  app.failSave({ code: 'REVISION_CONFLICT', message: '设置已被其他窗口更新' }); await app.click('保存');
  app.setRevision(7); await app.click('读取最新设置并保留草稿');
  assert.equal(app.button('10 K Token').props['aria-pressed'], true);
  app.failSave(null); await app.click('保存');
  assert.equal(app.lastSave.revision, 7);
  assert.equal(app.lastSave.settings.chunkTokens, 10000);
});
