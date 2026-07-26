export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

export interface CdnMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: {
    media?: CdnMedia;
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
    playtime?: number;
    text?: string;
  };
  image_item?: {
    media?: CdnMedia;
    thumb_media?: CdnMedia;
    aeskey?: string;
    url?: string;
    mid_size?: number;
  };
  file_item?: {
    media?: CdnMedia;
    file_name?: string;
    md5?: string;
    len?: string;
  };
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "need_verifycode"
  | "verify_code_blocked"
  | "scaned_but_redirect"
  | "binded_redirect";

export interface QrStatusResponse {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}
