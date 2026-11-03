// Satoshi is under the ITF Free Font License: self-hosting on our own site is allowed, but redistributing the files
// (a public repository counts) and converting or subsetting them are not. So the official webfont is fetched from
// Fontshare at build time into public/fonts (gitignored) and served as it ships.
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const out = join(import.meta.dir, "../public/fonts")
const file = "Satoshi-Variable.woff2"

if (!existsSync(join(out, file))) {
  const temp = mkdtempSync(join(tmpdir(), "satoshi-"))
  try {
    const response = await fetch("https://api.fontshare.com/v2/fonts/download/satoshi")
    if (!response.ok) throw new Error(`Fontshare download failed: ${response.status}`)
    const zip = join(temp, "satoshi.zip")
    await Bun.write(zip, response)
    const unzip = Bun.spawnSync(["unzip", "-o", "-q", "-j", zip, `*/WEB/fonts/${file}`, "*/License/FFL.txt", "-d", temp])
    if (unzip.exitCode !== 0) throw new Error(`unzip failed: ${unzip.stderr.toString()}`)
    mkdirSync(out, { recursive: true })
    copyFileSync(join(temp, file), join(out, file))
    copyFileSync(join(temp, "FFL.txt"), join(out, "Satoshi-LICENSE.txt"))
    console.log(`fonts: fetched ${file} from Fontshare`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
