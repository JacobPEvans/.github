($b[0].entries // {}) as $o
| .entries | to_entries[]
| select(.value.sha != ($o[.key].sha // "") and ($o[.key].sha // "") != "")
| "\(.key)|\(.value.repo | split("/") | .[0:2] | join("/"))|\(.value.sha)|\($o[.key].sha)"
