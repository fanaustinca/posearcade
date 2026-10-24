// Public-domain melodies. Every melody note becomes one block; hitting the
// block plays that note, so the player performs the song.
//
// melody tokens:  E4:1 (note+octave : beats)   r:0.5 (rest)   | (bar line)   @130 (tempo change)
// chords tokens:  Am:2 (chord : beats)         _:1 (no chord)
// Durations default to 1 beat when ":n" is omitted.

export const SONGS = [
  {
    id: 'twinkle', name: 'Twinkle Twinkle', voice: 'musicbox', bpm: 100, level: 1,
    melody: `C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 |
             G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 |
             C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2`,
    chords: `C:2 C:2 F:2 C:2 F:2 C:2 G:2 C:2 C:2 G:2 C:2 G:2 C:2 G:2 C:2 G:2
             C:2 C:2 F:2 C:2 F:2 C:2 G:2 C:2`,
  },
  {
    id: 'mary', name: 'Mary Had a Little Lamb', voice: 'marimba', bpm: 110, level: 1,
    melody: `E4 D4 C4 D4 | E4 E4 E4:2 | D4 D4 D4:2 | E4 G4 G4:2 |
             E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4:4`,
    chords: `C:4 C:4 G:4 C:4 C:4 C:4 G:4 C:4`,
  },
  {
    id: 'ode', name: 'Ode to Joy', voice: 'organ', bpm: 108, level: 2,
    melody: `F#4 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | F#4:1.5 E4:0.5 E4:2 |
             F#4 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | E4:1.5 D4:0.5 D4:2 |
             E4 E4 F#4 D4 | E4 F#4:0.5 G4:0.5 F#4 D4 | E4 F#4:0.5 G4:0.5 F#4 E4 | D4 E4 A3:2 |
             F#4 F#4 G4 A4 | A4 G4 F#4 E4 | D4 D4 E4 F#4 | E4:1.5 D4:0.5 D4:2`,
    chords: `D:2 D:2 D:2 A:2 D:2 A:2 D:2 A:2  D:2 D:2 D:2 A:2 D:2 A:2 A:2 D:2
             A:2 D:2 A:2 D:2 A:2 D:2 G:2 A:2  D:2 D:2 D:2 A:2 D:2 A:2 A:2 D:2`,
  },
  {
    id: 'jingle', name: 'Jingle Bells', voice: 'sleigh', bpm: 120, level: 2,
    melody: `E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 |
             F4 F4 F4:1.5 F4:0.5 | F4 E4 E4 E4:0.5 E4:0.5 | E4 D4 D4 E4 | D4:2 G4:2 |
             E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 |
             F4 F4 F4 F4 | F4 E4 E4 E4:0.5 E4:0.5 | G4 G4 F4 D4 | C4:4`,
    chords: `C:4 C:4 C:4 C:4 F:4 C:4 D:4 G:4 C:4 C:4 C:4 C:4 F:4 C:4 G:4 C:4`,
  },
  {
    id: 'birthday', name: 'Happy Birthday', voice: 'piano', bpm: 100, level: 2,
    melody: `G4:0.75 G4:0.25 | A4 G4 C5 | B4:2 G4:0.75 G4:0.25 | A4 G4 D5 | C5:2 G4:0.75 G4:0.25 |
             G5 E5 C5 | B4 A4 F5:0.75 F5:0.25 | E5 C5 D5 | C5:3`,
    chords: `_:1 C:3 G:3 G:3 C:3 C:3 F:3 C:2 G:1 C:3`,
  },
  {
    id: 'canon', name: 'Canon in D', voice: 'strings', bpm: 62, level: 2,
    melody: `F#5 E5 D5 C#5 | B4 A4 B4 C#5 |
             D5 C#5 B4 A4 | G4 F#4 G4 E4 |
             D4:0.5 F#4:0.5 A4:0.5 G4:0.5 F#4:0.5 D4:0.5 F#4:0.5 E4:0.5 |
             D4:0.5 B3:0.5 D4:0.5 A4:0.5 G4:0.5 B4:0.5 A4:0.5 G4:0.5 |
             F#4:0.5 D4:0.5 E4:0.5 C#5:0.5 D5:0.5 F#5:0.5 A5:0.5 A4:0.5 |
             B4:0.5 G4:0.5 A4:0.5 F#4:0.5 D4:0.5 D5:0.5 D5 |
             F#5 E5 D5 C#5 | B4 A4 B4 C#5 | D5:4`,
    chords: `D A Bm F#m G D G A  D A Bm F#m G D G A  D A Bm F#m G D G A
             D A Bm F#m G D G A  D A Bm F#m G D G A  D:4`,
  },
  {
    id: 'frere', name: 'Frère Jacques', voice: 'marimba', bpm: 112, level: 1,
    melody: `C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 |
             G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 |
             C4 G3 C4:2 | C4 G3 C4:2`,
    chords: `C:4 C:4 C:4 C:4 C:4 C:4 C:1 G:1 C:2 C:1 G:1 C:2`,
  },
  {
    id: 'row', name: 'Row Row Row Your Boat', voice: 'musicbox', bpm: 200, level: 1,
    melody: `C4:3 C4:3 | C4:2 D4 E4:3 | E4:2 D4 E4:2 F4 | G4:6 |
             C5 C5 C5 G4 G4 G4 | E4 E4 E4 C4 C4 C4 | G4:2 F4 E4:2 D4 | C4:6`,
    chords: `C:6 C:6 C:6 C:6 C:6 C:6 G:6 C:6`,
  },
  {
    id: 'london', name: 'London Bridge', voice: 'chip', bpm: 116, level: 1,
    melody: `G4:1.5 A4:0.5 G4 F4 | E4 F4 G4:2 | D4 E4 F4:2 | E4 F4 G4:2 |
             G4:1.5 A4:0.5 G4 F4 | E4 F4 G4:2 | D4:2 G4:2 | E4 C4:3`,
    chords: `C:4 C:4 G:4 C:4 C:4 C:4 G:4 C:4`,
  },
  {
    id: 'macdonald', name: 'Old MacDonald', voice: 'banjo', bpm: 120, level: 1,
    melody: `G4 G4 G4 D4 | E4 E4 D4:2 | B4 B4 A4 A4 | G4:3 D4 |
             G4 G4 G4 D4 | E4 E4 D4:2 | B4 B4 A4 A4 | G4:4`,
    chords: `G:4 C:2 G:2 G:2 D:2 G:4 G:4 C:2 G:2 G:2 D:2 G:4`,
  },
  {
    id: 'yankee', name: 'Yankee Doodle', voice: 'flute', bpm: 126, level: 2,
    melody: `C4 C4 D4 E4 | C4 E4 D4 G3 | C4 C4 D4 E4 | C4:2 B3:2 |
             C4 C4 D4 E4 | F4 E4 D4 C4 | B3 G3 A3 B3 | C4:2 C4:2`,
    chords: `C:2 C:2 C:2 G:2 C:2 C:2 C:2 G:2 C:2 C:2 F:2 C:2 G:2 G:2 C:4`,
  },
  {
    id: 'saints', name: 'When the Saints', voice: 'brass', bpm: 132, level: 2,
    melody: `r C4 E4 F4 | G4:4 | r C4 E4 F4 | G4:4 | r C4 E4 F4 | G4:2 E4:2 | C4:2 E4:2 | D4:4 |
             r E4 E4 D4 | C4:3 C4 | E4:2 G4:2 | G4 G4 F4:2 | r C4 E4 F4 | G4:2 E4:2 | C4:2 D4:2 | C4:4`,
    chords: `C:4 C:4 C:4 C:4 C:4 C:4 G:4 G:4 C:4 C:4 C:4 F:4 C:4 C:4 G:4 C:4`,
  },
  {
    id: 'grace', name: 'Amazing Grace', voice: 'strings', bpm: 84, level: 2,
    melody: `D4 | G4:2 B4:0.5 G4:0.5 | B4:2 A4 | G4:2 E4 | D4:2 D4 | G4:2 B4:0.5 G4:0.5 | B4:2 A4 | D5:3 |
             D5:2 B4 | D5:1.5 B4:0.5 D5:0.5 B4:0.5 | G4:2 D4 | E4:1.5 G4:0.5 G4:0.5 E4:0.5 | D4:2 D4 |
             G4:2 B4:0.5 G4:0.5 | B4:2 A4 | G4:3`,
    chords: `_:1 G:3 G:3 C:3 G:3 G:3 D:3 D:3 G:3 G:3 G:3 C:3 G:3 G:3 D:3 G:3`,
  },
  {
    id: 'greensleeves', name: 'Greensleeves', voice: 'flute', bpm: 190, level: 2,
    melody: `A4 | C5:2 D5 E5:1.5 F5:0.5 E5 | D5:2 B4 G4:1.5 A4:0.5 B4 | C5:2 A4 A4:1.5 G#4:0.5 A4 | B4:2 G#4 E4:2 A4 |
             C5:2 D5 E5:1.5 F5:0.5 E5 | D5:2 B4 G4:1.5 A4:0.5 B4 | C5:1.5 B4:0.5 A4 G#4:1.5 F#4:0.5 G#4 | A4:6`,
    chords: `_:1 Am:6 G:6 Am:6 E:6 Am:6 G:6 Am:3 E:3 Am:6`,
  },
  {
    id: 'minuet', name: 'Minuet in G', voice: 'harpsi', bpm: 120, level: 3,
    melody: `D5 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | D5 G4 G4 | E5 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | G5 G4 G4 |
             C5 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | B4 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | F#4 G4:0.5 A4:0.5 B4:0.5 G4:0.5 | A4:3 |
             D5 G4:0.5 A4:0.5 B4:0.5 C5:0.5 | D5 G4 G4 | E5 C5:0.5 D5:0.5 E5:0.5 F#5:0.5 | G5 G4 G4 |
             C5 D5:0.5 C5:0.5 B4:0.5 A4:0.5 | B4 C5:0.5 B4:0.5 A4:0.5 G4:0.5 | A4 B4:0.5 A4:0.5 G4:0.5 F#4:0.5 | G4:3`,
    chords: `G:3 G:3 C:3 G:3 C:3 G:3 D:3 D:3 G:3 G:3 C:3 G:3 C:3 G:3 D:3 G:3`,
  },
  {
    id: 'elise', name: 'Für Elise', voice: 'piano', bpm: 66, level: 3,
    melody: `E5:0.25 D#5:0.25 | E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 |
             A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | B4:0.5 r:0.25 E4:0.25 G#4:0.25 B4:0.25 |
             C5:0.5 r:0.25 E4:0.25 E5:0.25 D#5:0.25 | E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 |
             A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | B4:0.5 r:0.25 E4:0.25 C5:0.25 B4:0.25 |
             A4:1 E5:0.25 D#5:0.25 | E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 |
             A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | B4:0.5 r:0.25 E4:0.25 G#4:0.25 B4:0.25 |
             C5:0.5 r:0.25 E4:0.25 E5:0.25 D#5:0.25 | E5:0.25 D#5:0.25 E5:0.25 B4:0.25 D5:0.25 C5:0.25 |
             A4:0.5 r:0.25 C4:0.25 E4:0.25 A4:0.25 | B4:0.5 r:0.25 E4:0.25 C5:0.25 B4:0.25 | A4:1.5`,
    chords: `_:0.5 _:1.5 Am:1.5 E:1.5 Am:1.5 _:1.5 Am:1.5 E:1.5 Am:1.5
             _:1.5 Am:1.5 E:1.5 Am:1.5 _:1.5 Am:1.5 E:1.5 Am:1.5`,
  },
  {
    id: 'tetris', name: 'Korobeiniki (Tetris)', voice: 'chip', bpm: 140, level: 3,
    melody: `E5 B4:0.5 C5:0.5 D5 C5:0.5 B4:0.5 | A4 A4:0.5 C5:0.5 E5 D5:0.5 C5:0.5 |
             B4:1.5 C5:0.5 D5 E5 | C5 A4 A4:2 |
             D5:1.5 F5:0.5 A5 G5:0.5 F5:0.5 | E5:1.5 C5:0.5 E5 D5:0.5 C5:0.5 |
             B4 B4:0.5 C5:0.5 D5 E5 | C5 A4 A4 r |
             E5 B4:0.5 C5:0.5 D5 C5:0.5 B4:0.5 | A4 A4:0.5 C5:0.5 E5 D5:0.5 C5:0.5 |
             B4:1.5 C5:0.5 D5 E5 | C5 A4 A4:2`,
    chords: `Am:2 E:2 Am:4 E:4 Am:4 Dm:4 C:4 E:4 Am:4 Am:2 E:2 Am:4 E:4 Am:4`,
  },
  {
    id: 'mountain', name: 'Hall of the Mountain King', voice: 'pizz', bpm: 100, level: 3,
    melody: `B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4 | E#4:0.5 C#4:0.5 E#4 E4:0.5 C4:0.5 E4 |
             B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4:0.5 B4:0.5 | A4:0.5 F#4:0.5 D4:0.5 F#4:0.5 A4:2 |
             @128
             B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4 | E#4:0.5 C#4:0.5 E#4 E4:0.5 C4:0.5 E4 |
             B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4:0.5 B4:0.5 | A4:0.5 F#4:0.5 D4:0.5 F#4:0.5 A4:2 |
             @160
             B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4 | E#4:0.5 C#4:0.5 E#4 E4:0.5 C4:0.5 E4 |
             B3:0.5 C#4:0.5 D4:0.5 E4:0.5 F#4:0.5 D4:0.5 F#4:0.5 B4:0.5 | A4:0.5 F#4:0.5 D4:0.5 F#4:0.5 A4:2 |
             B4:2 B3:2`,
    chords: `Bm:4 F#:4 Bm:4 D:4  Bm:4 F#:4 Bm:4 D:4  Bm:4 F#:4 Bm:4 D:4  Bm:4`,
  },
];

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiOf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) throw new Error('bad note ' + name);
  return 12 * (+m[3] + 1) + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
}
function chordTones(name) {
  const m = /^([A-G])(#|b)?(m?)$/.exec(name);
  const root = 48 + NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return [root, root + (m[3] ? 3 : 4), root + 7];
}

// -> { notes: [{t, dur, midi, barStart, chord?: {tones, dur}}], duration } in seconds
export function parseSong(song, tempoMul = 1) {
  const tempo = [{ beat: 0, time: 0, bpm: song.bpm * tempoMul }];
  const notes = [];
  let beat = 0, time = 0, bpm = song.bpm * tempoMul, barStart = true;
  for (const tok of song.melody.trim().split(/\s+/)) {
    if (tok === '|') { barStart = true; continue; }
    if (tok[0] === '@') { bpm = +tok.slice(1) * tempoMul; tempo.push({ beat, time, bpm }); continue; }
    const [name, b = '1'] = tok.split(':'), beats = +b, dur = beats * 60 / bpm;
    if (name !== 'r') { notes.push({ t: time, dur, midi: midiOf(name), barStart, beat }); barStart = false; }
    beat += beats; time += dur;
  }
  const beatToTime = (bt) => {
    let seg = tempo[0];
    for (const s of tempo) if (s.beat <= bt + 1e-9) seg = s;
    return seg.time + (bt - seg.beat) * 60 / seg.bpm;
  };
  // Each chord rides on the first note that starts inside its window.
  let cb = 0;
  for (const tok of song.chords.trim().split(/\s+/)) {
    const [name, b = '1'] = tok.split(':'), beats = +b;
    if (name !== '_') {
      const n = notes.find(n => n.beat >= cb - 1e-9 && n.beat < cb + beats - 1e-9);
      if (n) n.chord = { tones: chordTones(name), dur: beatToTime(cb + beats) - n.t };
    }
    cb += beats;
  }
  return { notes, duration: time + 1.5 };
}
