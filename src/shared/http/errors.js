export const failure = (status, message) => Object.assign(new Error(message), { status });

export function publicError(error) {
  return {
    status: error.status ?? error.statusCode ?? 400,
    body: {
      error: error.status || error.statusCode
        ? error.message
        : 'Case action could not be completed. Check consent and workflow prerequisites.',
    },
  };
}
