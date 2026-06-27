import { View } from 'react-native'

export function VoiceModeIcon({ size, color }: { size: number; color: string }) {
  const barW = 3
  const barGap = 2
  const heights = [size * 0.45, size, size * 0.45]
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: size }}>
      {heights.map((h, i) => (
        <View
          key={i}
          style={{ width: barW, height: h, borderRadius: barW / 2, backgroundColor: color, marginLeft: i === 0 ? 0 : barGap }}
        />
      ))}
    </View>
  )
}

export function StopGlyph() {
  return <View style={{ width: 17, height: 17, borderRadius: 3, backgroundColor: '#e23b3b' }} />
}
