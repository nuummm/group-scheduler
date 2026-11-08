import { badRequest, readJson } from "./api";
import {
  addIsland,
  addSeat,
  clearAllSeats,
  clearAway,
  getAttendance,
  listAttendanceLog,
  removeIsland,
  removeSeat,
  renameIsland,
  renameSeat,
  setIslandSeatKind,
  setSeatKind,
  setSeatStatus,
  toggleSeat,
  undoSeatChange,
} from "./attendance";
import {
  accessParticipant,
  addEventGrade,
  addEventGroup,
  clearGroupSchedules,
  copyEventCategories,
  createEvent,
  deleteEvent,
  deleteEventGrade,
  deleteEventGroup,
  deleteParticipant,
  getEventRevision,
  getEventView,
  listEvents,
  renameEventGrade,
  saveParticipantSchedule,
  updateEventGroup,
  updateEventInfo,
  updateEventNotes,
  updateEventSlots,
  updateParticipantVisibility,
  upsertParticipant,
} from "./events";
import { type Params, type Route, route } from "./router";
import {
  addGradeSchema,
  addGroupSchema,
  addSeatSchema,
  createEventSchema,
  eventInfoSchema,
  eventNotesSchema,
  extraSlotsOnlySchema,
  islandRenameSchema,
  parseFilterQuery,
  parseParticipantQuery,
  participantAccessSchema,
  participantDeleteSchema,
  participantVisibilitySchema,
  saveScheduleSchema,
  seatKindSchema,
  seatRenameSchema,
  seatStatusSchema,
  seatToggleSchema,
  seatUndoSchema,
  updateGroupSchema,
  upsertParticipantSchema,
} from "./validation";

/** 照合が通った時点でキーは必ず埋まっているが、`Params` は索引型なので型の上では欠けうる。 */
function param(params: Params, key: string): string {
  return params[key] ?? "";
}

/** 数字だけの ID を受け付ける。断る文言は画面にそのまま出るので、呼ぶ側の言葉で渡す。 */
function numericId(raw: string, message: string): number {
  const id = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isInteger(id)) {
    throw badRequest(message);
  }
  return id;
}

export const apiRoutes: Route[] = [
  route("/api/attendance", {
    GET: { run: () => getAttendance() },
  }),
  route("/api/attendance/log", {
    GET: {
      run: (_request, _params, url) => {
        const raw = url.searchParams.get("limit");
        const limit = raw ? Number.parseInt(raw, 10) : 50;
        return { entries: listAttendanceLog(Number.isInteger(limit) ? limit : 50) };
      },
    },
  }),
  // すべての席を不在に戻す（帰り際の押し忘れをまとめて片付ける）。
  route("/api/attendance/clear", {
    POST: { run: () => clearAllSeats() },
  }),
  route("/api/attendance/islands", {
    POST: { run: () => addIsland(), status: 201 },
  }),
  route("/api/attendance/islands/:islandKey", {
    /**
     * 島に対するまとめ操作。受け付けるのは 1 リクエストにつき 1 つ。
     *
     * - `label`    : 島の名前（空文字なら「島 1」のような自動採番の表示に戻る）
     * - `seatKind` : 島のマスをまとめて席 / 席なしに切り替える
     */
    PATCH: {
      run: async (request, params) => {
        const islandKey = param(params, "islandKey");
        const body = await readJson(request);
        if ("label" in body) {
          return renameIsland(islandKey, islandRenameSchema.parse(body).label);
        }
        if ("seatKind" in body) {
          return setIslandSeatKind(islandKey, seatKindSchema.parse(body).seatKind);
        }
        throw badRequest("変更する項目が指定されていません。");
      },
    },
    DELETE: { run: (_request, params) => removeIsland(param(params, "islandKey")) },
  }),
  route("/api/attendance/seats", {
    POST: {
      run: async (request) => {
        const { islandKey } = addSeatSchema.parse(await readJson(request));
        return addSeat(islandKey);
      },
      status: 201,
    },
  }),
  route("/api/attendance/seats/:seatKey", {
    /** 席カードのタップ（在室中 ↔ 不在）。`silent` で Slack へのお知らせを止められる。 */
    POST: {
      run: async (request, params) => {
        const seatKey = param(params, "seatKey");
        const { silent } = seatToggleSchema.parse(await readJson(request));
        return toggleSeat(seatKey, { silent });
      },
    },
    /**
     * 席の属性変更。`status`（離席中・不在）・`label`（席名）・`seatKind`（席 / 席なし）の
     * いずれか 1 つを受け付ける。
     */
    PATCH: {
      run: async (request, params) => {
        const seatKey = param(params, "seatKey");
        const body = await readJson(request);
        if ("status" in body) {
          const { status } = seatStatusSchema.parse(body);
          // 離席をやめるときの戻り先は、離席にする前の状態。クライアントが決めると
          // 「不在から離席した人」を在室にしてしまうので、サーバーが履歴から決める。
          return status === "clear-away" ? clearAway(seatKey) : setSeatStatus(seatKey, status);
        }
        if ("label" in body) {
          return renameSeat(seatKey, seatRenameSchema.parse(body).label);
        }
        if ("seatKind" in body) {
          return setSeatKind(seatKey, seatKindSchema.parse(body).seatKind);
        }
        throw badRequest("変更する項目が指定されていません。");
      },
    },
    DELETE: { run: (_request, params) => removeSeat(param(params, "seatKey")) },
  }),
  route("/api/attendance/seats/:seatKey/undo", {
    /**
     * 直前の操作を取り消す。
     *
     * 席の状態を 1 つ前へ戻し、保留中の Slack 通知も破棄する。猶予の内であれば、
     * 誤って押した在室が Slack に出ることはない。
     *
     * `eventId` を添えると、それが最後の変更であるときだけ戻す。添えないと、
     * 押したあとに他の人が同じ席を触っていた場合にその人の操作を巻き戻してしまう。
     */
    POST: {
      run: async (request, params) => {
        const seatKey = param(params, "seatKey");
        const { eventId } = seatUndoSchema.parse(await readJson(request));
        return undoSeatChange(seatKey, eventId);
      },
    },
  }),

  route("/api/events", {
    GET: { run: () => ({ events: listEvents() }) },
    POST: {
      run: async (request) => {
        const input = createEventSchema.parse(await readJson(request));
        const created = createEvent(input);
        // 作ったあとに引き継ぐ。作成そのものが失敗する理由を増やさないよう、
        // 引き継ぎに失敗してもイベントは残す（区分とグループは手で足せる）。
        if (input.copyFromSlug) {
          try {
            copyEventCategories(created.slug, input.copyFromSlug);
          } catch (error) {
            // 画面には出さないが、引き継がれなかった理由は後から追えるようにしておく。
            console.error("[scheduler] カテゴリの引き継ぎに失敗", error);
          }
        }
        return created;
      },
      status: 201,
    },
  }),
  route("/api/events/:slug", {
    GET: {
      run: (request, params, url) => {
        const { groupFilterIds, gradeFilterIds, filterMode } = parseFilterQuery(url);
        const { participantId, editKey } = parseParticipantQuery(request);
        return getEventView(param(params, "slug"), {
          participantId,
          editKey,
          groupFilterIds,
          gradeFilterIds,
          filterMode,
        });
      },
    },
    /**
     * イベント情報・共有メモ・追加コマのどれかを更新する。
     *
     * 追加コマだけを送れるようにしてあるのは、コマを 1 つ足すために名前と説明まで送り直すと、
     * その間に誰かが名前を直していたときに巻き戻してしまうため。
     */
    PATCH: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const body = await readJson(request);
        if ("notes" in body) {
          return updateEventNotes(slug, eventNotesSchema.parse(body).notes);
        }
        if (!("title" in body)) {
          // どれも入っていないなら、配列の形について説明する前に、
          // 何も指定されていないことを言う。
          if (!("extraSlots" in body)) {
            throw badRequest("変更する項目が指定されていません。");
          }
          return updateEventSlots(slug, extraSlotsOnlySchema.parse(body).extraSlots);
        }
        return updateEventInfo(slug, eventInfoSchema.parse(body));
      },
    },
    DELETE: {
      run: (_request, params) => {
        const slug = param(params, "slug");
        deleteEvent(slug);
        return { deleted: true, slug };
      },
    },
  }),
  /**
   * 変化があったかだけを返す軽い入口。
   *
   * 複数人で同じイベントを開いている前提なので、各端末は数秒おきにここを見る。
   * 値が変わったときだけ画面ぶんの本体（`/api/events/:slug`）を取りに行く。
   */
  route("/api/events/:slug/revision", {
    GET: { run: (_request, params) => getEventRevision(param(params, "slug")) },
  }),
  /**
   * 予定表の保存。属性（名前・区分・グループ・メモ）と予定を **1 回で** 書く。
   *
   * 2 回に分けると、片方だけ通って片方が落ちる状態が起きる。複数人が同時に触る前提なので、
   * ここは 1 トランザクションにまとめる。開いてから他の端末が保存していたら 409 を返す。
   */
  route("/api/events/:slug/schedule", {
    PUT: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const input = saveScheduleSchema.parse(await readJson(request));
        return { saved: true, ...saveParticipantSchedule({ slug, ...input }) };
      },
    },
  }),
  // 別のイベントから区分とグループを引き継ぐ。参加者や予定は持ってこない。
  route("/api/events/:slug/categories", {
    POST: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const body = (await readJson(request)) as { sourceSlug?: unknown };
        if (typeof body.sourceSlug !== "string" || !body.sourceSlug) {
          throw badRequest("引き継ぎ元のイベントを選んでください。");
        }
        return copyEventCategories(slug, body.sourceSlug);
      },
    },
  }),
  route("/api/events/:slug/grades", {
    POST: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const { name } = addGradeSchema.parse(await readJson(request));
        return addEventGrade(slug, name);
      },
      status: 201,
    },
  }),
  route("/api/events/:slug/grades/:gradeId", {
    /** 名前の変更。入力の決まりは追加のときと同じなので同じスキーマを使う。 */
    PATCH: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "gradeId"), "区分の指定が不正です。");
        const { name } = addGradeSchema.parse(await readJson(request));
        return renameEventGrade(slug, id, name);
      },
    },
    DELETE: {
      run: (_request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "gradeId"), "区分の指定が不正です。");
        return { deleted: true, gradeId: id, ...deleteEventGrade(slug, id) };
      },
    },
  }),
  route("/api/events/:slug/groups", {
    POST: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const { name } = addGroupSchema.parse(await readJson(request));
        return addEventGroup(slug, name);
      },
      status: 201,
    },
  }),
  /**
   * 人が決めた置き場所をまとめて捨てる。
   * `?keep=pinned` を付けると仮決め済みは残し、掴んで動かしただけの位置を捨てる。
   */
  route("/api/events/:slug/groups/schedule", {
    DELETE: {
      run: (_request, params, url) => {
        const keepPinned = url.searchParams.get("keep") === "pinned";
        return clearGroupSchedules(param(params, "slug"), { keepPinned });
      },
    },
  }),
  route("/api/events/:slug/groups/:groupId", {
    /** グループの設定変更。1 回の長さと、確定した開催枠。 */
    PATCH: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "groupId"), "グループの指定が不正です。");
        return updateEventGroup(slug, id, updateGroupSchema.parse(await readJson(request)));
      },
    },
    DELETE: {
      run: (_request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "groupId"), "グループの指定が不正です。");
        return { deleted: true, groupId: id, ...deleteEventGroup(slug, id) };
      },
    },
  }),
  /**
   * 参加者の登録・更新。
   *
   * 戻り値は編集に必要な認証情報だけで、全体表は含めない（含めると 1 セルの保存でも
   * 全参加者ぶんの集計が走る）。
   * 画面の更新はクライアントが GET で取り直す。
   */
  route("/api/events/:slug/participants", {
    POST: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const input = upsertParticipantSchema.parse(await readJson(request));
        return upsertParticipant({ slug, ...input });
      },
      status: 201,
    },
  }),
  // 登録済みメンバーの予定表を開く（パスワードが設定されていれば照合する）。
  route("/api/events/:slug/participants/access", {
    POST: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const { participantId, password } = participantAccessSchema.parse(await readJson(request));
        return accessParticipant(slug, participantId, password);
      },
    },
  }),
  route("/api/events/:slug/participants/:participantId", {
    PATCH: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "participantId"), "参加者が見つかりません。");
        const { hiddenInMatrix } = participantVisibilitySchema.parse(await readJson(request));
        return updateParticipantVisibility(slug, id, hiddenInMatrix);
      },
    },
    DELETE: {
      run: async (request, params) => {
        const slug = param(params, "slug");
        const id = numericId(param(params, "participantId"), "参加者が見つかりません。");
        const { password } = participantDeleteSchema.parse(await readJson(request));
        return { deleted: true, participantId: id, ...deleteParticipant(slug, id, password) };
      },
    },
  }),
];
