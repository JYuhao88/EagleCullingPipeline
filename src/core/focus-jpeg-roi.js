import sharp from 'sharp';

// Full-frame coordinates after the native orientation transform.
export function alignedJpegRect(roi, width, height) {
  const left = Math.floor(roi.left / 8) * 8, top = Math.floor(roi.top / 8) * 8;
  const right = Math.min(width, Math.ceil((roi.left + roi.width) / 8) * 8);
  const bottom = Math.min(height, Math.ceil((roi.top + roi.height) / 8) * 8);
  return { left, top, width: right - left, height: bottom - top };
}

// Materialise the existing native transform before crop: flop-only pipelines otherwise extract before flop.
export async function alignedNativeJpegRoi(image, size, roi) {
  const pixels = await image().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  return alignedPixelsJpegRoi(pixels, size, roi);
}

export async function alignedPixelsJpegRoi(pixels, size, roi) {
  const raw = { width: pixels.info.width, height: pixels.info.height, channels: pixels.info.channels };
  const aligned = alignedJpegRect(roi, size.width, size.height);
  const encoded = await sharp(pixels.data, { raw }).extract(aligned).jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).toBuffer();
  const offset = { left: roi.left - aligned.left, top: roi.top - aligned.top, width: roi.width, height: roi.height };
  return sharp(encoded).extract(offset).raw().toBuffer({ resolveWithObject: true });
}

export async function alignedFocusJpegRoi(pixels, size, roi) {
  const cropped = await alignedPixelsJpegRoi(pixels, size, roi);
  const raw = { width: cropped.info.width, height: cropped.info.height, channels: cropped.info.channels };
  return sharp(cropped.data, { raw }).jpeg().toBuffer();
}

export function blockIndependentJpegDefaults() {
  const options = sharp().jpeg({ quality: 96, chromaSubsampling: '4:4:4' }).options;
  return options.jpegProgressive === false && options.jpegTrellisQuantisation === false &&
    options.jpegOvershootDeringing === false && options.jpegOptimiseScans === false && options.jpegQuantisationTable === 0;
}
