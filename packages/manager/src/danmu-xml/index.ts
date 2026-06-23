// 弹幕 XML 写入(XmlDanmuWriter,biliLive RecorderXmlStyle 格式)。原 @drec/danmaku-core,
// 因唯一消费者是 manager 而下沉至此(契约 DanmuWriter/DanmuMessage 仍在 @drec/core)。
export * from "./xml-writer.js";
export * from "./recorder-xml-style.js";
