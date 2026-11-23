/**
 * SHA-256 of Heirloom's own demo documents (docs/demo-documents). Only these exact files get the reviewer's
 * "this is a test specimen" note, and only on a test network: the footer text alone proves nothing, because anyone
 * can type it on a forged document. specimens.test.ts fails when a file changes without this list.
 */
export const SPECIMEN_SHA256: ReadonlySet<string> = new Set([
  // accepted
  "98c9b63cf1d7b7b13af7d4c9c8cc005cbe7a1fa81c52fa98899a8775b954b684",
  "dc50c15ac6c8854026f25fc30079987dbb22d08e6e875f4355294b01830e3b98",
  "8c9f392304926a0ab535d96e53bff3778701335b0b2d8f01081dca11c6ea8d0f",
  "ac64adde19b04efcce14768458db18518adb54fece6a45200edf20d3c00b593a",
  "a8602694a3ae67a22492a08984556609fd0d424868f231af621df01d413fd0e2",
  // bills
  "aaa223a43cb06752ce6e2b1f24900648af8dcaf982a7747b43c433845f649c81",
  "d9f1ae029d04cfc61985de5600829d91ff7e109c09f04d74509129b185b95cdd",
  // rejected (they must still fail, for their real faults)
  "364072556c6f60a7dd38024fc5e74230ed3862fcaf7668d696c0372a7fc1dc70",
  "00b85561b7779efcf3dee7e16b0c72153f4bf6084796c1e9a1268c762bd61e53",
  "25bd1e3f6acc947f2f328c37bfc7ba38b8cdb6a9048ab6ba52fee66ef6dc3285",
  "4fc2f6bd42872f2f567d5e113d9fb9ca5b459b19f034f99e1ca7242b1d5f188d",
  "2543da425f05778c46fd24cf38058a72ed08080e8133d121ed92d16d93953075",
]);
