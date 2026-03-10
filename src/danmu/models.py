"""弹幕数据模型（源自 DanmakuRender/DMR/utils/danmaku.py）"""

from datetime import datetime


class SimpleDanmaku:
    def __init__(self, time: float = None, timestamp: float = None,
                 dtype: str = None, uname: str = None,
                 color: str = 'ffffff', content: str = None,
                 text: str = None, **kwargs) -> None:
        # time: 相对时间（秒），timestamp: 绝对 Unix 时间戳
        self.time = time
        if isinstance(timestamp, datetime):
            self.timestamp = timestamp.timestamp()
        elif timestamp is None:
            self.timestamp = datetime.now().timestamp()
        else:
            self.timestamp = float(timestamp)
        self.dtype = dtype
        self.uname = uname
        self.color = color
        self.content = content
        for key, value in kwargs.items():
            self.__dict__[key] = value
        self.text = text if text is not None else self.content

    def __getitem__(self, key):
        return self.__dict__[key]

    def __iter__(self):
        yield from self.__dict__.items()


class GiftDanmaku(SimpleDanmaku):
    def __init__(self, text: str = None, price: float = None,
                 gift_name: str = '', gift_count: int = 1,
                 gift_price: float = 0.0, price_unit: str = '',
                 *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.gift_name = gift_name
        self.gift_count = int(gift_count)
        self.gift_price = float(gift_price)
        self.price_unit = price_unit
        self.price = price if price is not None else self.gift_price * self.gift_count
        self.dtype = 'gift'
        self.text = text if text is not None else \
            f'{self.uname}: 送了 {self.gift_count} 个 {self.gift_name}'
