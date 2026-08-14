// Domain-level errors. Pure TypeScript, thrown by RepoContext implementations
// (and anything else operating purely within the domain).

export class FileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly sizeBytes: number,
    public readonly maxBytes: number,
  ) {
    super(`File "${path}" is ${sizeBytes} bytes, exceeding the ${maxBytes}-byte read limit`);
    this.name = "FileTooLargeError";
  }
}
