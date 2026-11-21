import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Bot, ChatMemberContext } from "gramio";
import { membershipHandler } from "bot/handlers";
import type { MembershipContext } from "bot/types";
import { logger } from "lib";

const bot = new Bot("test");
const user = { id: 1, is_bot: true, first_name: "Mirai" };
const GROUP = { id: -1001234567890, type: "supergroup", title: "Мемы" };

const membership = (
	chat: object,
	before: string,
	after: string,
): MembershipContext =>
	new ChatMemberContext({
		bot,
		update_id: 1,
		payload: {
			chat,
			from: { id: 2, is_bot: false, first_name: "Admin" },
			date: 0,
			old_chat_member: { status: before, user },
			new_chat_member: { status: after, user },
		},
	} as never) as unknown as MembershipContext;

describe("membershipHandler", () => {
	let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;
	beforeEach(() => {
		infoSpy = spyOn(logger, "info").mockImplementation(() => {});
	});
	afterEach(() => infoSpy.mockRestore());

	test("logs the group the bot was added to", () => {
		membershipHandler(membership(GROUP, "left", "member"));

		expect(infoSpy).toHaveBeenCalledWith(
			'[chat] added to supergroup "Мемы" (-1001234567890)',
		);
	});

	test("logs the group the bot was removed from", () => {
		membershipHandler(membership(GROUP, "member", "kicked"));

		expect(infoSpy).toHaveBeenCalledWith(
			'[chat] removed from supergroup "Мемы" (-1001234567890)',
		);
	});

	test("logs a change of the bot's rights inside a group", () => {
		membershipHandler(membership(GROUP, "member", "administrator"));

		expect(infoSpy).toHaveBeenCalledWith(
			'[chat] now administrator in supergroup "Мемы" (-1001234567890)',
		);
	});

	test("stays silent when a person blocks the bot in a private chat", () => {
		membershipHandler(
			membership({ id: 456, type: "private" }, "member", "kicked"),
		);

		expect(infoSpy).not.toHaveBeenCalled();
	});
});
