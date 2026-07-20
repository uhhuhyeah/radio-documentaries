# Intro - what's the point

In this repo we will research, edit, and produce LLM-powered "radio documentaries" for me based off the DJ personas in `~/code/homelab/subwave-config` for my homelab-based LLM-powered radio SUB/WAVE.

## SUB/WAVE

Insert here intro into what SUB/WAVE is, how it works/how I've set it up (Navidrome, OpenRouter, ElevenLabs etc).


## SUB/WAVE Personas

Insert into here Persona BIOs and ElevenLabs voice IDs.

## "Making of" documentaries

The first programme we will produce will be a series of "making of" documentaries based off of albums in my Navidrome collection that I am fond of. There will be other programming later. 

**High-level flow**

1. I will provide a target album and artist (that exists in Navidrome)
2. Producer Agent will create a new directory within this repo for the new work. It will validate the basic details and resolve any discrepency up front.
3. Producer Agent will task Researcher Agent to scour the internet for details and anecdotes surrounding the making of that specific album and prepare detailed and organised notes to pass back to Producer Agent.
  - Example prompt I have used in the past:
  ```
  Do a deep dive for me on the making of Pheobe Bridgers' "Punisher" album. I want to know as much as possible about the writing process, the instruments used, the studios used, the recording chain(s), the challenges and triumphs that went into making this record. When you have gathered all of this, I want you to make for me a file for me to read and reference. But instead of a markdown file, please use HTML and take advantage of the extra latitude you get with layout, style and interactivity. (Context: I am a musician and write and record my own material and this is one of my top albums from a writing and production standpoint. I want to absorb and learn. Approach this like I am an avid fan and fellow songwriter/musician/producer.)
  ```
4. When Producer Agent is happy with the research, it will dispatch the Script Writer Agent to read the research notes and compile a script for the show's episode (using the research given - the writer agent will not do any of it's own web searching and it will not guess or make up details, so it's imperitive that the Researcher Agent provide exhaustive notes).
  - The Script Writer agent will target content to be 20-30 minutes in length where possible
  - The Script Writer agent will write a script that reflects the persona of the host who will be presenting the content.
  - The Script Writer agent will be able to include actual songs from that album in the programming so it can reference 1-3 tracks from the album on-air.
  - The Script Writer agent will provide a formatted script file in the working directory set up by the Producer Agent in step 2 that can be easily split into spoken segments and passed section by section into the ElevenLabs API without the need for editing of the outcoming audio. An example script format will be made available to the Script Writer Agent in the working repo.
  - To aid in quality control, the Script Writer Agent will also output a list of issues it had (if any) with the research into a file in the working directory. Eg if the Script Writer Agent didn't know if this album was the band's 2nd album or 3rd album, or if the research didn't include any context for what other bands were doing things in the same time/space and wanted to reference.
5. With the delivered script, the Producer Agent will ensure quality and formatting, directing back the Script Writer agent any necessary tweaks or fixes. 
6. With a finalised script, the Producer Agent will supervise a subagent to convert segments of the script into sorted/organised audio files via the ElevenLabs API using the desired DJ Persona Voice.
  - For example, there is an intro, part 1, song 1, part 2, conclusion in a script, we would send the intro text to ElevenLabs for `sXXeXX_1_intro.mp3`, part 1 into `sXXeXX_2_part_1.mp3` etc. Song 1 is not an ElevenLabs concern because that would be referencing a song from this album that is in Navidrome.
7. With all script parts recorded, the Producer Agent will copy the files into the correct folder in Navidrome, and create a Navidrome Playlist for this Season and Episode with each audio part falling at the correct place in the playlist, and reference songs added to the playlist in the spots left open for it. The end result will be that I can load that playlist in Navidrome, play it in order and listen to a well research, well written, well hosted radio documentary on a given album.


## ElevenLabs

Insert here details on the ElevenLabs API and/or any SDKs or Libraries from ElevenLabs we will use. https://elevenlabs.io/docs/eleven-api/guides/cookbooks/text-to-speech


## Navidrome

Navidrome is a self-hosted, open source music server and streamer. It is running in LXC106 on the Homelab server, reachable because we will always be running on a Tailscale-enabled connection. Insert relevant details from `/Users/davidamcclain/sync-vault/04 - Life/Homelab/Navidrome Music Server.md` including folder location.
