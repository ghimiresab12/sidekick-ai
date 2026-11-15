"""A lightweight, synthetic AI avatar frame for LiveKit video publishing."""

from livekit import rtc

WIDTH = 320
HEIGHT = 240


def _pixel(buffer: bytearray, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    if 0 <= x < WIDTH and 0 <= y < HEIGHT:
        offset = (y * WIDTH + x) * 4
        buffer[offset : offset + 4] = bytes(color)


def _rect(
    buffer: bytearray,
    left: int,
    top: int,
    right: int,
    bottom: int,
    color: tuple[int, int, int, int],
) -> None:
    for y in range(max(0, top), min(HEIGHT, bottom)):
        start = (y * WIDTH + max(0, left)) * 4
        end = (y * WIDTH + min(WIDTH, right)) * 4
        buffer[start:end] = bytes(color) * ((end - start) // 4)


def _ellipse(
    buffer: bytearray,
    center_x: int,
    center_y: int,
    radius_x: int,
    radius_y: int,
    color: tuple[int, int, int, int],
) -> None:
    for y in range(max(0, center_y - radius_y), min(HEIGHT, center_y + radius_y + 1)):
        for x in range(max(0, center_x - radius_x), min(WIDTH, center_x + radius_x + 1)):
            dx = (x - center_x) / radius_x
            dy = (y - center_y) / radius_y
            if dx * dx + dy * dy <= 1:
                _pixel(buffer, x, y, color)


def _glyph(
    buffer: bytearray,
    pattern: tuple[str, ...],
    left: int,
    top: int,
    scale: int,
    color: tuple[int, int, int, int],
) -> None:
    for row, bits in enumerate(pattern):
        for column, bit in enumerate(bits):
            if bit == "1":
                _rect(
                    buffer,
                    left + column * scale,
                    top + row * scale,
                    left + (column + 1) * scale,
                    top + (row + 1) * scale,
                    color,
                )


def make_ai_avatar_frame() -> rtc.VideoFrame:
    """Build an AI-labeled illustration; it contains no captured camera media."""
    pixels = bytearray(WIDTH * HEIGHT * 4)

    # Dark gradient background.
    for y in range(HEIGHT):
        amount = y / (HEIGHT - 1)
        color = (
            int(18 + 16 * amount),
            int(25 + 7 * amount),
            int(53 + 36 * amount),
            255,
        )
        _rect(pixels, 0, y, WIDTH, y + 1, color)

    # Headset-like robot avatar.
    _rect(pixels, 155, 37, 165, 58, (115, 126, 255, 255))
    _ellipse(pixels, 160, 34, 9, 9, (66, 224, 218, 255))
    _ellipse(pixels, 160, 103, 78, 72, (79, 89, 190, 255))
    _ellipse(pixels, 160, 103, 66, 61, (174, 185, 255, 255))
    _rect(pixels, 103, 82, 217, 132, (35, 43, 95, 255))

    # Face and mouth.
    _ellipse(pixels, 131, 104, 8, 10, (70, 235, 226, 255))
    _ellipse(pixels, 189, 104, 8, 10, (70, 235, 226, 255))
    _rect(pixels, 142, 129, 178, 135, (255, 204, 105, 255))

    # Small shoulders and chest panel make the image clearly illustrative.
    _ellipse(pixels, 160, 190, 62, 36, (103, 111, 232, 255))
    _rect(pixels, 119, 174, 201, 220, (103, 111, 232, 255))
    _rect(pixels, 132, 181, 188, 211, (35, 43, 95, 255))
    _glyph(
        pixels,
        ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
        138,
        186,
        3,
        (70, 235, 226, 255),
    )
    _glyph(
        pixels,
        ("111", "010", "010", "010", "010", "010", "111"),
        164,
        186,
        3,
        (70, 235, 226, 255),
    )

    return rtc.VideoFrame(WIDTH, HEIGHT, rtc.VideoBufferType.RGBA, pixels)
