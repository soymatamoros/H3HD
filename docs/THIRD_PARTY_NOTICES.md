# Third-party software and model notices

This application is not an official MiniMax, NVIDIA, Microsoft or Comfy-Org
product. Names identify compatible software or hardware. No endorsement or
trademark license is implied. The application owner's license choice for the
original source has not been made; `LICENSE` does not grant redistribution rights.

## Included in the Windows application

| Component | Installed version | License | Source / notice |
| --- | --- | --- | --- |
| Electron | 40.10.6 | MIT, plus Chromium/Node/V8/other component licenses | <https://github.com/electron/electron>; packaged `LICENSE.electron.txt` and `LICENSES.chromium.html` |
| React / React DOM | 19.3.1 | MIT | <https://github.com/facebook/react>; `docs/licenses/react-LICENSE.txt`, `react-dom-LICENSE.txt` |
| Lucide React | 0.468.0 | ISC (with included icon attribution) | <https://github.com/lucide-icons/lucide>; `docs/licenses/lucide-react-LICENSE.txt` |
| ws | 8.22.1 | MIT | <https://github.com/websockets/ws>; `docs/licenses/ws-LICENSE.txt` |
| 7zip-bin npm wrapper | 5.2.0 | MIT | <https://github.com/develar/7zip-bin>; `docs/licenses/7zip-bin-MIT.txt` |
| 7-Zip standalone extractor 7za.exe | 21.07 x64 | GNU LGPL 2.1 or later, with included component notices | <https://github.com/ip7z/7zip/tree/21.07>; `docs/licenses/7zip-21.07-License.txt`, `7zip-LGPL-2.1.txt` |

The MIT license of the npm wrapper does not replace the license of the included
7-Zip executable. The extractor is an unmodified, separate process; source for
its corresponding release is available at
<https://github.com/ip7z/7zip/tree/21.07>. Full upstream 7-Zip license text is
retained, including the notices for BSD components and unRAR restrictions; see
that text for applicability to individual source files.

Electron's distribution supplies the Chromium license inventory separately;
do not remove that file from release packages. Complete dependency versions and
integrity metadata are retained in `package-lock.json`. Development-only tooling
(Vite, TypeScript, electron-builder, tsx and their dependencies) retains its own
licenses in the installed packages and is not required on the end-user machine.

## Optional first-run downloads

These packages and weights are **not bundled** in the Windows ZIP. Their
licenses remain independent of the application's original code.

- **ComfyUI v0.43.0**: GNU GPL v3; official source and portable archive at
  <https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.43.0>. The bootstrap leaves
  the archive's Python, PyTorch, CUDA and other dependency notices intact. Their
  licenses are not automatically GPL just because ComfyUI uses GPL.
- **FFmpeg 8.1 BtbN GPL build**: the selected build is labeled GPL v3+; source,
  configuration and build information are provided by
  <https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-02-12-51>.
  The bootstrap retains the archive's license files. Codec patent requirements,
  if applicable to a distribution or jurisdiction, are separate from copyright
  licenses; no codec patent license is represented as granted here.
- **MiniMax H3 weights**: official Comfy documentation states that commercial use
  of locally generated results requires a MiniMax commercial license through
  <https://comfy.org/minimax/license>. Use the model manifest and full official
  model card/license for the selected file as well. Do not treat ComfyUI's GPL
  license as a license to H3 weights. Network policy prevented independent access
  to the requested Hugging Face model page in this cloud session; the full model
  license text remains unverified and installation does not imply commercial
  permission.
- **SDXL / any separately selected image weights**: each model's own card and
  license applies. An architecture name is not evidence of the license of an
  arbitrary checkpoint file. Review the actual manifest entry/source before
  accepting a download.

Generated media does not inherit a single uniform license from these software
dependencies. Applicable model terms, source material rights and the user's
rights in prompts/references remain separate questions.
