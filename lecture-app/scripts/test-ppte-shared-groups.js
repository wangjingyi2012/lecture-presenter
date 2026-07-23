const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const editorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-editor.js'), 'utf8');
const sharedSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'js', 'ppte-shared-groups.js'), 'utf8');
let sequence = 0;
const context = {
  console,
  crypto: {
    randomUUID() {
      sequence += 1;
      return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
    },
  },
  window: {
    Settings: {},
  },
  confirm: () => true,
  alert(message) {
    throw new Error(`Unexpected alert: ${message}`);
  },
};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(editorSource, context);
vm.runInContext(sharedSource, context);

const editor = context.window.Settings;

{
  const manifest = {
    title: 'Legacy deck',
    customRootField: { keep: true },
    slides: [
      { file: 'slide01.html', title: 'One', note: 'notes/one.note', customSlideField: 'keep' },
      { file: 'slide02.html', title: 'Two' },
    ],
  };
  manifest.slides = editor._normalizeManifestSlides(manifest.slides);
  const changed = editor._ensurePpteStableIds(manifest);

  assert.equal(changed, true);
  assert.equal(manifest.schemaVersion, 2);
  assert.match(manifest.deckId, /^deck_/);
  assert.match(manifest.slides[0].id, /^slide_/);
  assert.notEqual(manifest.slides[0].id, manifest.slides[1].id);
  assert.deepEqual(Array.from(manifest.sharedGroups), []);
  assert.deepEqual(Array.from(manifest.linkedGroups), []);

  manifest.sharedGroups.push({ id: editor._newPpteId('group'), name: 'Group', slideIds: [manifest.slides[0].id] });
  manifest.linkedGroups.push({ groupId: 'remote', sourceDeckId: 'source', targetSlideIds: [manifest.slides[1].id] });
  manifest.slides[0].html = '<html></html>';
  manifest.slides[0].dirty = true;
  manifest.slides[0].linkedFrom = { groupId: 'remote', sourceSlideId: 'source-slide' };

  const clean = editor._cleanManifestObject(manifest);
  assert.equal(clean.customRootField.keep, true);
  assert.equal(clean.slides[0].customSlideField, 'keep');
  assert.equal(clean.slides[0].note, 'notes/one.note');
  assert.equal(clean.slides[0].linkedFrom.groupId, 'remote');
  assert.equal('html' in clean.slides[0], false);
  assert.equal('dirty' in clean.slides[0], false);
  assert.equal(clean.sharedGroups.length, 1);
  assert.equal(clean.linkedGroups.length, 1);

  const ids = clean.slides.map(slide => slide.id);
  const normalizedAgain = editor._normalizeManifestSlides(clean.slides);
  assert.deepEqual(Array.from(normalizedAgain, slide => slide.id), ids);
}

{
  assert.equal(editor._indexesAreContiguous([1]), true);
  assert.equal(editor._indexesAreContiguous([1, 2, 3]), true);
  assert.equal(editor._indexesAreContiguous([1, 3]), false);
  assert.equal(editor._indexesAreContiguous([]), false);
}

{
  const file = editor._nextPpteSlideFile({
    slides: [
      { file: 'slide01.html' },
      { file: '.ppte-links/group/snapshots/hash/slide02.html' },
      { file: 'slide07.html' },
    ],
  });
  assert.equal(file, 'slide08.html');
  assert.equal(editor._sharedGroupStatusLabel('update_available'), '有更新');
  assert.equal(editor._sharedGroupStatusLabel('local_modified'), '本地已改');
}

async function runWorkflowTests() {
  const calls = [];
  context.window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === 'ppte_shared_group_snapshot') {
          return {
            sourceDeckId: 'deck_source',
            groupId: 'group_source',
            name: 'Reusable pages',
            contentHash: editor.__sourceHash || 'source_hash_1',
            snapshotHash: 'snapshot_hash_1',
            snapshotRoot: '.ppte-links/group_source/snapshots/source_hash_1',
            slides: [
              {
                sourceSlideId: 'source_slide_1',
                targetFile: '.ppte-links/group_source/snapshots/source_hash_1/slide01.html',
                title: 'Shared one',
                slideType: 'content',
              },
              {
                sourceSlideId: 'source_slide_2',
                targetFile: '.ppte-links/group_source/snapshots/source_hash_1/slide02.html',
                title: 'Shared two',
                slideType: 'content',
              },
            ],
          };
        }
        if (command === 'read_text_file') return `<html>${args.filePath}</html>`;
        if (command === 'ppte_shared_group_inspect') {
          return {
            sourceDeckId: 'deck_source',
            groupId: 'group_source',
            name: 'Reusable pages',
            contentHash: editor.__sourceHash || 'source_hash_1',
            slides: [],
          };
        }
        if (command === 'ppte_shared_snapshot_hash') {
          return editor.__snapshotHash || 'snapshot_hash_1';
        }
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  };
  editor._pptBuilder = {
    folderPath: '/target',
    manifest: {
      schemaVersion: 2,
      deckId: 'deck_target',
      title: 'Target',
      slides: [{ id: 'target_slide', file: 'slide01.html', title: 'Target', slide_type: 'content', html: '<html>target</html>' }],
      sharedGroups: [],
      linkedGroups: [],
    },
    slides: [{ id: 'target_slide', file: 'slide01.html', title: 'Target', slide_type: 'content', html: '<html>target</html>' }],
    currentSlideIndex: 0,
    linkedGroupStatuses: {},
    manifestDirty: false,
  };
  editor._showToast = () => {};
  editor._renderPptBuilderInContent = () => {};
  editor._showSharedGroupsManager = () => {};
  editor._savePptBuilderData = async pb => {
    pb.manifestDirty = false;
    return { saved: ['manifest.json'], conflicts: [] };
  };

  await editor._insertSharedGroup('/source', 'group_source');
  assert.equal(editor._pptBuilder.slides.length, 3);
  assert.equal(editor._pptBuilder.slides[1].linkedFrom.groupId, 'group_source');
  assert.equal(editor._pptBuilder.manifest.linkedGroups.length, 1);
  assert.deepEqual(
    Array.from(editor._pptBuilder.manifest.linkedGroups[0].targetSlideIds),
    Array.from(editor._pptBuilder.slides.slice(1).map(slide => slide.id)),
  );

  await editor._checkLinkedGroups({ silent: true });
  assert.equal(editor._pptBuilder.linkedGroupStatuses.group_source.state, 'current');

  editor.__sourceHash = 'source_hash_2';
  await editor._checkLinkedGroups({ silent: true });
  assert.equal(editor._pptBuilder.linkedGroupStatuses.group_source.state, 'update_available');

  editor.__snapshotHash = 'locally_modified';
  await editor._checkLinkedGroups({ silent: true });
  assert.equal(editor._pptBuilder.linkedGroupStatuses.group_source.state, 'local_modified');
  assert.equal(editor._pptBuilder.linkedGroupStatuses.group_source.sourceUpdated, true);

  const linkedIdsBeforeSync = Array.from(editor._pptBuilder.manifest.linkedGroups[0].targetSlideIds);
  await editor._syncLinkedGroup('group_source');
  assert.deepEqual(
    Array.from(editor._pptBuilder.manifest.linkedGroups[0].targetSlideIds),
    linkedIdsBeforeSync,
  );
  assert.equal(editor._pptBuilder.manifest.linkedGroups[0].sourceContentHash, 'source_hash_2');
  assert.equal(editor._pptBuilder.linkedGroupStatuses.group_source.state, 'current');
  assert.ok(calls.some(call => call.command === 'ppte_shared_group_snapshot'));
}

runWorkflowTests()
  .then(() => console.log('ppte shared group tests passed'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
