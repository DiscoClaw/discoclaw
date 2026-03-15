export type TaskMetrics = {
  increment(name: string, value?: number): void;
};

export const noopTaskMetrics: TaskMetrics = {
  increment() {},
};
