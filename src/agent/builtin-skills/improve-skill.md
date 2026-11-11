---
id: improve-skill
name: 完善技能
name_en: Improve skill
description: 根据使用中发现的问题修改已有技能：补步骤、收紧输出格式、纠正容易出错的地方
description_en: Revise an existing skill based on problems found in use
icon: 🛠
---
帮用户改进一个已有的技能。

1. 先用 `read_skill` 读出要改的技能全文；用户没说是哪个，就列出技能目录让他选（用 `ask_user`）。
2. 弄清楚哪里不好用：是漏了步骤、输出格式不稳定、取数口径不对，还是触发时机不清楚。用户已经说清的不要再问。
3. 只改有问题的部分，保留原有的 id 和其余内容；改动处在回复里用一两句话说明原因。
4. 把改好的完整 SKILL.md 放在一个 ```skill 代码块里输出，并提醒：点击「保存为技能」会覆盖原技能；管理员也可以让你调用 `save_skill`（overwrite=true）直接保存。
5. 内置技能不能覆盖：要改内置技能，就换一个新的 id 另存。
