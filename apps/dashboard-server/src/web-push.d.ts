declare module 'web-push' {
  interface WebPushClient {
    setVapidDetails(
      subject: string,
      publicKey: string,
      privateKey: string,
    ): void;
    sendNotification(
      subscription: unknown,
      payload: string,
      options?: { TTL?: number; topic?: string },
    ): Promise<unknown>;
  }
  const webPush: WebPushClient;
  export default webPush;
}
