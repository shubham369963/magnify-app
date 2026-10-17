export interface CaptionedPage {
  pageNumber: number;
  caption: string;
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Image processing concurrency must be a positive integer.');
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const start = () => {
        this.active += 1;
        resolve();
      };
      if (this.active < this.limit) start();
      else this.waiting.push(start);
    });
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

export class PdfImageProcessor {
  private readonly images: ConcurrencyLimiter;
  private readonly renders: ConcurrencyLimiter;

  constructor(private readonly concurrency: number, renderConcurrency: number) {
    this.images = new ConcurrencyLimiter(concurrency);
    this.renders = new ConcurrencyLimiter(renderConcurrency);
  }

  async process(
    pageNumbers: readonly number[],
    render: (pageNumber: number) => Promise<Buffer>,
    caption: (image: Buffer) => Promise<string>,
    onProgress?: (completed: number) => Promise<void>,
  ): Promise<CaptionedPage[]> {
    const results = new Array<CaptionedPage>(pageNumbers.length);
    let next = 0;
    let completed = 0;
    let failed = false;
    let failure: unknown;
    let progress = Promise.resolve();
    const assertNotFailed = () => {
      if (failed) throw failure;
    };
    const work = async () => {
      while (!failed && next < pageNumbers.length) {
        const index = next++;
        const pageNumber = pageNumbers[index];
        try {
          results[index] = await this.images.run(async () => {
            assertNotFailed();
            const image = await this.renders.run(() => {
              assertNotFailed();
              return render(pageNumber);
            });
            assertNotFailed();
            return { pageNumber, caption: await caption(image) };
          });
          const count = ++completed;
          progress = progress.then(() => onProgress?.(count));
          await progress;
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    };
    // Drain in-flight pages before the caller removes its temporary directory.
    await Promise.all(Array.from({ length: Math.min(this.concurrency, pageNumbers.length) }, work));
    if (failed) throw failure;
    return results;
  }
}
