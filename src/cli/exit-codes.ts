// Ported from brooswit-factory/candlestix src/cli/exit-codes.ts at
// 13a520aa90464ec1b79ba2324864c074b0f51a3c. Bakr has no daemon-unreachable
// case; code 3 means its in-process action could not serve the request.
export const EXIT_SUCCESS = 0;
export const EXIT_REFUSAL = 1;
export const EXIT_USAGE = 2;
export const EXIT_FAILURE = 3;
