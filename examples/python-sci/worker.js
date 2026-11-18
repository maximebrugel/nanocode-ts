import { PythonSci } from '../../dist/bash/index.js'
import python from '../../dist/polars/python.wasm'

export default {
  fetch(request, env) {
    return PythonSci.serve(request, { module: python, data: PythonSci.assets(env.ASSETS) })
  },
}
