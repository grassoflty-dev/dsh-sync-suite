/**
 * 最小化的 ohosTest 测试入口。
 *
 * 作用：ACE Tools 的 `ace build apk` 会无条件编译 `ohosTest` target，
 * 并在打包阶段拷贝 `build/default/intermediates/loader_out/ohosTest/ets`。
 * 没有测试代码时该目录不存在，打包会因 ENOENT 失败，因此这里保留一个空测试套件。
 */
export default function testsuite(): void {
  // 应用自身的逻辑测试在 Node 侧运行（apps/arkui-schedule/tools/test），
  // 这里只保证 HarmonyOS instrument 测试 target 能被编译。
}
