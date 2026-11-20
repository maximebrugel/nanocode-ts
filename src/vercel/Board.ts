import * as Board from '../Board.ts'
import * as Wasm from './Wasm.ts'

export * from '../Board.ts'

export async function open(options: Board.Options): Promise<Board.Board> {
  return Board.open({ ...options, module: options.module ?? (await Wasm.load()) })
}
