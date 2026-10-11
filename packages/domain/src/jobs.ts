export type JobEnvelope<T> = {
  type: string;
  payload: T;
};
