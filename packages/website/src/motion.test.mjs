import test from "node:test";
import assert from "node:assert/strict";

function preview() {
  return {
    open: false,
    dataset: {},
    animations: [],
    showModal() { this.open = true; },
    close() { this.open = false; },
    animate(frames, options) {
      const animation = {
        frames, options,
        cancel() { this.oncancel?.(); },
      };
      this.animations.push(animation);
      return animation;
    },
  };
}

test("preview retains native modal until exit finishes and ignores repeated close", async () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false });
  try {
    const { openPreview, closePreview } = await import("../public/motion.js?test=normal");
    const dialog = preview();
    openPreview(dialog);
    assert.equal(dialog.open, true);
    assert.equal(dialog.animations.length, 1);
    closePreview(dialog);
    closePreview(dialog);
    assert.equal(dialog.open, true);
    assert.equal(dialog.animations.length, 2);
    dialog.animations.at(-1).onfinish();
    assert.equal(dialog.open, false);
    assert.equal(dialog.dataset.closing, undefined);
    openPreview(dialog);
    assert.equal(dialog.open, true);
  } finally {
    if (original) globalThis.matchMedia = original;
    else delete globalThis.matchMedia;
  }
});

test("reduced motion opens and closes immediately without animation", async () => {
  const original = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const { openPreview, closePreview } = await import("../public/motion.js?test=reduced");
    const dialog = preview();
    openPreview(dialog);
    assert.equal(dialog.open, true);
    closePreview(dialog);
    assert.equal(dialog.open, false);
    assert.equal(dialog.animations.length, 0);
  } finally {
    if (original) globalThis.matchMedia = original;
    else delete globalThis.matchMedia;
  }
});
