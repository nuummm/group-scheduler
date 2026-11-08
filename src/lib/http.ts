/**
 * 画面と API で取り決めているヘッダー名。
 *
 * 編集キー（本人確認の鍵）は URL に載せない。URL は Cloudflare のアクセスログに
 * そのまま残るので、クエリに置くと鍵がログに散らばる。
 */
export const EDIT_KEY_HEADER = "X-Edit-Key";
