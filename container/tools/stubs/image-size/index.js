// pptxgenjs lists image-size as a dependency but does not import it. The
// runtime tools manifest overrides the package with this stub so the
// unpatched parser never ships; anything that does call it fails loudly.
function imageSize() {
  throw new Error(
    'image-size is not available in the HybridClaw runtime tools; the package is intentionally replaced by a stub.',
  );
}

module.exports = imageSize;
module.exports.imageSize = imageSize;
module.exports.default = imageSize;
