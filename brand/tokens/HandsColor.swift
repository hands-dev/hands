import SwiftUI

public enum HandsColor {
    public static let aqua = Color(hex: 0x00E0C6)
    public static let cobalt = Color(hex: 0x4D7CFF)
    public static let orchid = Color(hex: 0xB85CFF)
    public static let coral = Color(hex: 0xFF5C7A)
    public static let amber = Color(hex: 0xFFB020)
    public static let accent = Color(hex: 0xB85CFF)
    public static let accentOnLight = Color(hex: 0x7A28C9)
    public static let ink = Color(hex: 0x0B0B0C)
    public static let paper = Color(hex: 0xF4F3F1)

    /// Station colours in mark order, pinky to thumb. Cap at five.
    public static let stations: [Color] = [aqua, cobalt, orchid, coral, amber]
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: 1)
    }
}
