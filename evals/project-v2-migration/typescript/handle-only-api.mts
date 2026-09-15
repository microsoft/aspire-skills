type Awaitable<T> = T | PromiseLike<T>;

interface Property<T> {
  get(): Promise<T>;
  set(value: T): Promise<void>;
}

interface ProjectResourceOptions {
  launchProfileName: Property<string | null>;
  excludeLaunchProfile: Property<boolean>;
  excludeKestrelEndpoints: Property<boolean>;
  toJSON(): Promise<unknown>;
}

interface AddDotnetProjectOptions {
  options?: Awaitable<ProjectResourceOptions>;
}
