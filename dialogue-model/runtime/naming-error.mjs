export class NamingTaskError extends Error {
  constructor(code) {
    super("Naming task failed: " + code);
    this.name = "NamingTaskError";
    this.code = code;
  }
}
