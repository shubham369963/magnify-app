function concurrencySetting(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error(`${name} must be an integer between 1 and 32.`);
  }
  return value;
}

function imageFilterSetting(name: string, raw: string | undefined, fallback: number, maximum: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw.trim());
  if (!raw.trim() || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${name} must be an integer between 0 and ${maximum}.`);
  }
  return value;
}

export function readPdfProcessingSettings() {
  return {
    workerConcurrency: concurrencySetting('PDF_WORKER_CONCURRENCY', process.env.PDF_WORKER_CONCURRENCY, 4),
    imageConcurrency: concurrencySetting('PDF_IMAGE_CONCURRENCY', process.env.PDF_IMAGE_CONCURRENCY, 4),
    renderConcurrency: concurrencySetting('PDF_RENDER_CONCURRENCY', process.env.PDF_RENDER_CONCURRENCY, 2),
    imageFilter: {
      minWidth: imageFilterSetting('PDF_IMAGE_MIN_WIDTH', process.env.PDF_IMAGE_MIN_WIDTH, 150, 10000),
      minHeight: imageFilterSetting('PDF_IMAGE_MIN_HEIGHT', process.env.PDF_IMAGE_MIN_HEIGHT, 150, 10000),
      minDisplayPoints: imageFilterSetting('PDF_IMAGE_MIN_DISPLAY_POINTS', process.env.PDF_IMAGE_MIN_DISPLAY_POINTS, 72, 2000),
      maxRepeatPages: imageFilterSetting('PDF_IMAGE_MAX_REPEAT_PAGES', process.env.PDF_IMAGE_MAX_REPEAT_PAGES, 3, 10000),
    },
  };
}
