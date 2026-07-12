// rmapi-js@11 ships ESM that imports "crc-32/crc32c" without a file
// extension, which bundlers resolve but plain Node ESM rejects
// (ERR_MODULE_NOT_FOUND). Its self-contained browser bundle has no such
// imports, so re-export from that instead. The package "exports" map doesn't
// expose the bundle, hence the direct node_modules path.
export {
  auth,
  register,
  remarkable,
  session,
  GenerationError,
  HashNotFoundError,
  ResponseError,
  ValidationError,
} from "../node_modules/rmapi-js/dist/rmapi-js.esm.min.js";
