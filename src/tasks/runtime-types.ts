import type { RuntimeAdapter, RuntimeId } from '../runtime/types.js';
import { resolveModel } from '../runtime/model-tiers.js';

export type TaskRuntimeAdapter = RuntimeAdapter;
export type TaskRuntimeId = RuntimeId;
export type TaskModelResolver = (model: string, runtimeId: TaskRuntimeId) => string;

export const resolveTaskRuntimeModel: TaskModelResolver = resolveModel;
