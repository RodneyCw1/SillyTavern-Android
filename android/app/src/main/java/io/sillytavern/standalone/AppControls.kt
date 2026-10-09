package io.sillytavern.standalone

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.InsetDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.Button
import android.widget.FrameLayout
import android.widget.PopupMenu
import kotlin.math.abs

/** A native control remains available while the WebView is loading or has crashed. */
internal class AppControls(context: Context, private val root: FrameLayout, action: (String) -> Unit) {
    private val density = context.resources.displayMetrics.density
    private fun Int.dp() = (this * density).toInt()
    private val preferences = context.getSharedPreferences("app_controls", Context.MODE_PRIVATE)
    private var right = preferences.getBoolean("right", false)
    private var fraction = preferences.getFloat("height_fraction", 0.5f).let { if (it.isFinite()) it.coerceIn(0f, 1f) else 0.5f }
    private var dragging = false
    private var downX = 0f
    private var downY = 0f
    private var startX = 0f
    private var startY = 0f
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val button = Button(context).apply {
        text = "⋮"
        contentDescription = "应用控制"
        textSize = 22f
        isAllCaps = false
        gravity = Gravity.CENTER
        minWidth = 0; minimumWidth = 0
        minHeight = 0; minimumHeight = 0
        setPadding(0, 0, 0, 0)
        setTextColor(context.getColor(R.color.toolbar_text))
        val circle = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(context.getColor(R.color.toolbar_surface))
            setStroke(1.dp(), context.getColor(R.color.toolbar_border))
        }
        background = InsetDrawable(RippleDrawable(ColorStateList.valueOf(context.getColor(R.color.toolbar_ripple)), circle, null), 8.dp())
        elevation = 0f
        stateListAnimator = null
        alpha = 0.7f
    }

    init {
        root.addView(button, FrameLayout.LayoutParams(48.dp(), 48.dp()))
        button.setOnClickListener {
            val menu = PopupMenu(context, button)
            for ((id, label) in listOf("update" to "更新", "restart" to "重启", "exit" to "退出")) {
                menu.menu.add(label).setOnMenuItemClickListener { action(id); true }
            }
            button.alpha = 1f
            menu.setOnDismissListener { button.alpha = 0.7f }
            menu.show()
        }
        button.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragging = false
                    downX = event.rawX; downY = event.rawY
                    startX = button.x; startY = button.y
                    button.isPressed = true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downX
                    val dy = event.rawY - downY
                    if (abs(dx) > slop || abs(dy) > slop) dragging = true
                    if (dragging) {
                        button.isPressed = false
                        val (left, top, maxX, maxY) = bounds()
                        button.x = (startX + dx).coerceIn(left, maxX)
                        button.y = (startY + dy).coerceIn(top, maxY)
                    }
                }
                MotionEvent.ACTION_UP -> {
                    button.isPressed = false
                    if (dragging) {
                        val (left, top, maxX, maxY) = bounds()
                        right = button.x > (left + maxX) / 2
                        if (maxY > top) fraction = ((button.y - top) / (maxY - top)).coerceIn(0f, 1f)
                        preferences.edit().putBoolean("right", right).putFloat("height_fraction", fraction).apply()
                        dragging = false
                        reposition()
                    } else button.performClick()
                }
                MotionEvent.ACTION_CANCEL -> {
                    button.isPressed = false
                    dragging = false
                    reposition()
                }
            }
            true
        }
        root.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> reposition() }
        root.post { reposition() }
    }

    private fun bounds(): FloatArray {
        val left = (root.paddingLeft + 8.dp()).toFloat()
        val top = (root.paddingTop + 8.dp()).toFloat()
        val maxX = (root.width - root.paddingRight - 8.dp() - button.width).toFloat().coerceAtLeast(left)
        val maxY = (root.height - root.paddingBottom - 8.dp() - button.height).toFloat().coerceAtLeast(top)
        return floatArrayOf(left, top, maxX, maxY)
    }

    fun reposition() {
        if (dragging || root.width == 0 || button.width == 0) return
        val (left, top, maxX, maxY) = bounds()
        button.x = if (right) maxX else left
        button.y = top + (maxY - top) * fraction
    }
}
